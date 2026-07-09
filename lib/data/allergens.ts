import { and, eq, inArray } from 'drizzle-orm';
import {
  ingredientAllergens,
  ingredients,
  recipeAllergenOverrides,
  recipeComponents,
  recipeIngredients,
} from '@/lib/db/schema';
import { MAX_COMPONENT_DEPTH } from '@/lib/calculations/production';
import type { TenantClient } from '@/lib/db/tenant';
import type { AllergenSlug, Presence } from '@/lib/allergens/catalog';
import { ALLERGEN_ORDER } from '@/lib/allergens/catalog';
import {
  comparePresence,
  recipeAllergens,
  type AllergenLine,
  type RecipeAllergenRollup,
} from '@/lib/calculations/allergens';
import { lockActiveIngredient } from '@/lib/data/ingredients';
import { getRecipeById, listRecipes } from '@/lib/data/recipes';

/**
 * Allergen data layer (Sprint 9). Every function is org-scoped (RULE #1) and runs
 * inside the caller's `withOrg` transaction so RLS is active. Batch loaders avoid
 * N+1 (§11.9). The mutations uphold the safety invariants (atomic replace, add/
 * escalate-only override, clear-never-suppresses) — see lib/calculations/allergens.ts.
 */

export type AllergenTag = { allergen: AllergenSlug; presence: Presence };

/** Sort tags by the fixed catalog order (deterministic UI/audit/document output). */
function sortTags<T extends { allergen: AllergenSlug }>(tags: T[]): T[] {
  return [...tags].sort((a, b) => ALLERGEN_ORDER[a.allergen] - ALLERGEN_ORDER[b.allergen]);
}

/** The allergen tags of one ingredient, catalog-sorted. */
export async function getIngredientAllergens(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
): Promise<AllergenTag[]> {
  const rows = await db
    .select({
      allergen: ingredientAllergens.allergen,
      presence: ingredientAllergens.presence,
    })
    .from(ingredientAllergens)
    .where(
      and(
        eq(ingredientAllergens.organizationId, organizationId),
        eq(ingredientAllergens.ingredientId, ingredientId),
      ),
    );
  return sortTags(
    rows.map((r) => ({
      allergen: r.allergen as AllergenSlug,
      presence: r.presence as Presence,
    })),
  );
}

/**
 * Batch-load allergen tags for many ingredients at once (no N+1). Returns a map
 * keyed by ingredient id; ingredients with no tags are simply absent from the map.
 */
export async function loadIngredientAllergensByIngredient(
  db: TenantClient,
  organizationId: string,
  ingredientIds: string[],
): Promise<Map<string, AllergenTag[]>> {
  const map = new Map<string, AllergenTag[]>();
  if (ingredientIds.length === 0) return map;

  const rows = await db
    .select({
      ingredientId: ingredientAllergens.ingredientId,
      allergen: ingredientAllergens.allergen,
      presence: ingredientAllergens.presence,
    })
    .from(ingredientAllergens)
    .where(
      and(
        eq(ingredientAllergens.organizationId, organizationId),
        inArray(ingredientAllergens.ingredientId, ingredientIds),
      ),
    );

  for (const r of rows) {
    const tag: AllergenTag = {
      allergen: r.allergen as AllergenSlug,
      presence: r.presence as Presence,
    };
    const existing = map.get(r.ingredientId);
    if (existing) existing.push(tag);
    else map.set(r.ingredientId, [tag]);
  }
  for (const [, tags] of map) sortTags(tags); // in place — keep stable per ingredient
  return map;
}

/** The recipe-level overrides for one recipe, catalog-sorted. */
export async function getRecipeOverrides(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
): Promise<AllergenTag[]> {
  const rows = await db
    .select({
      allergen: recipeAllergenOverrides.allergen,
      presence: recipeAllergenOverrides.presence,
    })
    .from(recipeAllergenOverrides)
    .where(
      and(
        eq(recipeAllergenOverrides.organizationId, organizationId),
        eq(recipeAllergenOverrides.recipeId, recipeId),
      ),
    );
  return sortTags(
    rows.map((r) => ({
      allergen: r.allergen as AllergenSlug,
      presence: r.presence as Presence,
    })),
  );
}

/**
 * Load everything needed to roll up ONE recipe's allergens and compute it.
 *
 * The ingredient join is deliberately NOT filtered by `deleted_at` (mirror the
 * recipe-cost join in lib/data/recipes.ts): a trashed-but-still-referenced
 * ingredient must never silently drop an allergen. Each recipe line becomes one
 * `AllergenLine` carrying that ingredient's reviewed flag + its allergen tags.
 */
export async function loadRecipeAllergenRollup(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
): Promise<RecipeAllergenRollup> {
  const rollups = await loadRecipeAllergensByIds(db, organizationId, [recipeId]);
  // Every requested id is present in the map by contract.
  return rollups.get(recipeId)!;
}

/** One recipe's name + its computed allergen rollup (for the matrix document). */
export type RecipeAllergenSummary = {
  recipeId: string;
  recipeName: string;
  rollup: RecipeAllergenRollup;
};

/**
 * Compute the allergen rollup for EVERY active recipe in the org, batched (no N+1):
 * one query for recipes, one for all their lines (joining the ingredient's review
 * flag), one for all allergen tags, one for all overrides — then the pure rollup in
 * memory. Money is NEVER selected here, so the matrix document is money-free by
 * construction. The line join is NOT `deleted_at`-filtered (a trashed-but-referenced
 * ingredient must still contribute its allergens). Ordered by recipe name.
 */
export async function loadOrgRecipeAllergens(
  db: TenantClient,
  organizationId: string,
): Promise<RecipeAllergenSummary[]> {
  const recipeRows = await listRecipes(db, organizationId);
  if (recipeRows.length === 0) return [];

  const rollups = await loadRecipeAllergensByIds(
    db,
    organizationId,
    recipeRows.map((r) => r.id),
  );
  return recipeRows.map((recipe) => ({
    recipeId: recipe.id,
    recipeName: recipe.name,
    rollup: rollups.get(recipe.id)!,
  }));
}

/**
 * Batch-compute the allergen rollup for a SPECIFIC set of recipe ids (Sprint 10,
 * menus). Works directly off `recipe_ingredients` keyed by the supplied ids, so a
 * TRASHED-but-still-referenced recipe contributes its allergens exactly the same as
 * an active one (a menu line never becomes silently allergen-free). One query for
 * lines (ingredient join NOT `deleted_at`-filtered, mirroring recipe cost), one for
 * all tags, one for overrides — then the pure rollup per id. Every requested id is
 * present in the returned map (a recipe with no lines/overrides → empty rollup).
 */
export async function loadRecipeAllergensByIds(
  db: TenantClient,
  organizationId: string,
  recipeIds: string[],
): Promise<Map<string, RecipeAllergenRollup>> {
  const map = new Map<string, RecipeAllergenRollup>();
  if (recipeIds.length === 0) return map;

  // ── Component closure (sub-recipes): inherited allergens come from the whole
  // subtree, so load lines/tags/overrides for every reachable recipe too. ──
  const closure = new Set<string>(recipeIds);
  let frontier = [...new Set(recipeIds)];
  const componentEdges: { recipeId: string; componentRecipeId: string }[] = [];
  for (let level = 0; frontier.length > 0 && level <= MAX_COMPONENT_DEPTH + 1; level += 1) {
    const rows = await db
      .select({
        recipeId: recipeComponents.recipeId,
        componentRecipeId: recipeComponents.componentRecipeId,
      })
      .from(recipeComponents)
      .where(
        and(
          eq(recipeComponents.organizationId, organizationId),
          inArray(recipeComponents.recipeId, frontier),
        ),
      );
    componentEdges.push(...rows);
    const next = new Set<string>();
    for (const row of rows) {
      if (!closure.has(row.componentRecipeId)) {
        closure.add(row.componentRecipeId);
        next.add(row.componentRecipeId);
      }
    }
    frontier = [...next];
  }
  const closureIds = [...closure];

  const lineRows = await db
    .select({
      recipeId: recipeIngredients.recipeId,
      ingredientId: recipeIngredients.ingredientId,
      reviewedAt: ingredients.allergensReviewedAt,
    })
    .from(recipeIngredients)
    .innerJoin(
      ingredients,
      and(
        eq(recipeIngredients.ingredientId, ingredients.id),
        eq(ingredients.organizationId, organizationId),
      ),
    )
    .where(
      and(
        eq(recipeIngredients.organizationId, organizationId),
        inArray(recipeIngredients.recipeId, closureIds),
      ),
    );

  const tagsByIngredient = await loadIngredientAllergensByIngredient(
    db,
    organizationId,
    lineRows.map((r) => r.ingredientId),
  );

  const overrideRows = await db
    .select({
      recipeId: recipeAllergenOverrides.recipeId,
      allergen: recipeAllergenOverrides.allergen,
      presence: recipeAllergenOverrides.presence,
    })
    .from(recipeAllergenOverrides)
    .where(
      and(
        eq(recipeAllergenOverrides.organizationId, organizationId),
        inArray(recipeAllergenOverrides.recipeId, closureIds),
      ),
    );

  const linesByRecipe = new Map<string, AllergenLine[]>();
  for (const row of lineRows) {
    const line: AllergenLine = {
      reviewed: row.reviewedAt !== null,
      allergens: tagsByIngredient.get(row.ingredientId) ?? [],
    };
    const existing = linesByRecipe.get(row.recipeId);
    if (existing) existing.push(line);
    else linesByRecipe.set(row.recipeId, [line]);
  }

  const overridesByRecipe = new Map<string, AllergenTag[]>();
  for (const row of overrideRows) {
    const tag: AllergenTag = {
      allergen: row.allergen as AllergenSlug,
      presence: row.presence as Presence,
    };
    const existing = overridesByRecipe.get(row.recipeId);
    if (existing) existing.push(tag);
    else overridesByRecipe.set(row.recipeId, [tag]);
  }

  const edgesByParent = new Map<string, string[]>();
  for (const edge of componentEdges) {
    const existing = edgesByParent.get(edge.recipeId);
    if (existing) existing.push(edge.componentRecipeId);
    else edgesByParent.set(edge.recipeId, [edge.componentRecipeId]);
  }

  // Memoized bottom-up rollup with visited/depth guards. On corrupted data
  // (cycle/over-depth) a component contributes an EMPTY rollup flagged
  // unreviewed — the recipe warns the kitchen instead of silently dropping
  // allergens or looping. A component's EFFECTIVE presences (its own overrides
  // included) inherit as derived (no-downgrade upheld by the pure rollup).
  const memo = new Map<string, RecipeAllergenRollup>();
  const UNRESOLVED: RecipeAllergenRollup = {
    allergens: [],
    hasUnreviewedIngredient: true,
  };
  const resolve = (
    recipeId: string,
    depth: number,
    visited: Set<string>,
  ): RecipeAllergenRollup => {
    const cached = memo.get(recipeId);
    if (cached) return cached;
    const inherited: RecipeAllergenRollup[] = [];
    for (const componentId of edgesByParent.get(recipeId) ?? []) {
      if (depth >= MAX_COMPONENT_DEPTH || visited.has(componentId)) {
        inherited.push(UNRESOLVED);
        continue;
      }
      const nextVisited = new Set(visited);
      nextVisited.add(componentId);
      inherited.push(resolve(componentId, depth + 1, nextVisited));
    }
    const rollup = recipeAllergens(
      linesByRecipe.get(recipeId) ?? [],
      overridesByRecipe.get(recipeId) ?? [],
      inherited,
    );
    memo.set(recipeId, rollup);
    return rollup;
  };

  for (const recipeId of recipeIds) {
    map.set(recipeId, resolve(recipeId, 0, new Set([recipeId])));
  }
  return map;
}

/** Outcome of {@link replaceIngredientAllergens}. */
export type ReplaceAllergensOutcome =
  | { status: 'done'; before: AllergenTag[]; after: AllergenTag[] }
  | { status: 'not_found' };

/**
 * Atomically REPLACE an ingredient's allergen tags and stamp the review (§11.8).
 * MUST run inside a `withOrg` transaction: it locks the active ingredient FOR
 * UPDATE (serializing against trash/pricing), deletes all existing tags, inserts
 * the new set, and sets `allergens_reviewed_at`/`_by` — all-or-nothing, so a
 * failure mid-replace rolls back every row AND the review stamp.
 *
 * An EMPTY `tags` array is valid: it marks the ingredient reviewed with zero
 * allergens (correctly "no allergens recorded", never "allergen-free"). Returns the
 * `before`/`after` tag sets so the caller can write a precise audit event.
 */
export async function replaceIngredientAllergens(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
  tags: AllergenTag[],
  reviewedBy: string | null,
): Promise<ReplaceAllergensOutcome> {
  if (!(await lockActiveIngredient(db, organizationId, ingredientId))) {
    return { status: 'not_found' };
  }

  const before = await getIngredientAllergens(db, organizationId, ingredientId);

  await db
    .delete(ingredientAllergens)
    .where(
      and(
        eq(ingredientAllergens.organizationId, organizationId),
        eq(ingredientAllergens.ingredientId, ingredientId),
      ),
    );

  if (tags.length > 0) {
    await db.insert(ingredientAllergens).values(
      tags.map((t) => ({
        organizationId,
        ingredientId,
        allergen: t.allergen,
        presence: t.presence,
      })),
    );
  }

  await db
    .update(ingredients)
    .set({ allergensReviewedAt: new Date(), allergensReviewedBy: reviewedBy })
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, ingredientId),
      ),
    );

  return { status: 'done', before, after: sortTags(tags) };
}

/** Outcome of {@link addOrEscalateRecipeOverride}. */
export type OverrideOutcome =
  | { status: 'done'; allergen: AllergenSlug; before: Presence | null; after: Presence }
  | { status: 'cannot_downgrade' }
  | { status: 'not_found' };

/**
 * ADD or ESCALATE one recipe-level allergen override (§1.F). Rejects anything that
 * is not a real add or escalation: the requested presence must be a NEW allergen
 * for the recipe, or STRICTLY HIGHER than the current effective presence — otherwise
 * `cannot_downgrade` (no write). This is the action-side half of the safety
 * guarantee (the read-side `max()` is the other half).
 *
 * MUST run inside `withOrg`. The recipe must be active and in this org.
 */
export async function addOrEscalateRecipeOverride(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
  allergen: AllergenSlug,
  presence: Presence,
): Promise<OverrideOutcome> {
  // Active, same-org recipe only — a trashed recipe must be restored before its
  // allergens can be edited (getRecipeById filters `deleted_at`).
  if (!(await getRecipeById(db, organizationId, recipeId))) {
    return { status: 'not_found' };
  }

  const rollup = await loadRecipeAllergenRollup(db, organizationId, recipeId);
  const current =
    rollup.allergens.find((a) => a.allergen === allergen)?.effectivePresence ?? null;

  // A real add (new allergen) or a strict escalation only.
  const isEscalation = current !== null && comparePresence(presence, current) > 0;
  const isNew = current === null;
  if (!isNew && !isEscalation) return { status: 'cannot_downgrade' };

  await db
    .insert(recipeAllergenOverrides)
    .values({ organizationId, recipeId, allergen, presence })
    .onConflictDoUpdate({
      target: [
        recipeAllergenOverrides.organizationId,
        recipeAllergenOverrides.recipeId,
        recipeAllergenOverrides.allergen,
      ],
      set: { presence },
    });

  return { status: 'done', allergen, before: current, after: presence };
}

/** Outcome of {@link clearRecipeOverride}. */
export type ClearOverrideOutcome =
  | { status: 'done'; allergen: AllergenSlug; removedPresence: Presence | null }
  | { status: 'not_found' };

/**
 * Clear ONE recipe-level override row (a manual addition/escalation). It can NEVER
 * suppress a derived allergen: the derived presence comes from ingredients, not
 * from overrides, so after a clear the effective recomputes to `max(derived, ∅) =
 * derived` — still ≥ derived. A separate, audited action. Returns the removed
 * presence (or null if there was no override) for the audit event.
 */
export async function clearRecipeOverride(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
  allergen: AllergenSlug,
): Promise<ClearOverrideOutcome> {
  if (!(await getRecipeById(db, organizationId, recipeId))) {
    return { status: 'not_found' };
  }

  const deleted = await db
    .delete(recipeAllergenOverrides)
    .where(
      and(
        eq(recipeAllergenOverrides.organizationId, organizationId),
        eq(recipeAllergenOverrides.recipeId, recipeId),
        eq(recipeAllergenOverrides.allergen, allergen),
      ),
    )
    .returning({ presence: recipeAllergenOverrides.presence });

  return {
    status: 'done',
    allergen,
    removedPresence: (deleted[0]?.presence as Presence | undefined) ?? null,
  };
}
