import { and, count, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  ingredientPrepActions,
  ingredients,
  recipeFolders,
  recipeIngredients,
  recipePresets,
  recipes,
  transactions,
} from '@/lib/db/schema';
import type { Ingredient, Recipe, NewRecipe } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { nullTaskRecipeLinks } from '@/lib/data/tasks';
import { syncBookMembershipForFolderMove } from '@/lib/data/recipe-books';

/**
 * Access to `recipes` is ALWAYS scoped by `organizationId`. See lib/data/ingredients.ts.
 * Soft-delete: active reads filter `deleted_at IS NULL`; trashed recipes surface
 * only through the trash-scoped reads below.
 */

export type RecipeInput = Omit<
  NewRecipe,
  'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

/** A recipe line joined with the ingredient detail needed for cost + display. */
export type RecipeLineWithIngredient = {
  id: string;
  ingredientId: string;
  /** Canonical amount (g / ml / count) the recipe USES (edible). */
  quantity: number;
  sortOrder: number;
  /**
   * Prep-action usable yield in basis points, or null/absent when the line has
   * no prep action (Recipes 2.0 §6.6). Feeds `lineCostCents` so required-
   * purchase loss inflates cost without double counting.
   */
  prepYieldBps?: number | null;
  ingredient: {
    name: string;
    dimension: Ingredient['dimension'];
    priceCents: number;
  };
};

export type RecipeWithIngredients = {
  recipe: Recipe;
  lines: RecipeLineWithIngredient[];
};

/**
 * Kitchen-facing recipe shapes (Sprint F4): the recipe with its money columns
 * (`laborCostCents` / `energyCostCents` / `packagingCostCents` /
 * `sellingPriceCents`) OMITTED, and lines whose ingredient carries NO `priceCents`.
 * The keys are literally absent, not zeroed, so a kitchen payload can never carry a
 * cost or selling price. Pages ship these to kitchen instead of the full shapes.
 */
export type KitchenRecipe = Omit<
  Recipe,
  'laborCostCents' | 'energyCostCents' | 'packagingCostCents' | 'sellingPriceCents'
>;

export type KitchenRecipeLine = {
  id: string;
  ingredientId: string;
  quantity: number;
  sortOrder: number;
  ingredient: { name: string; dimension: Ingredient['dimension'] };
};

export type KitchenRecipeWithIngredients = {
  recipe: KitchenRecipe;
  lines: KitchenRecipeLine[];
};

/** Strips the money columns from a recipe row for a kitchen payload. */
export function toKitchenRecipe(row: Recipe): KitchenRecipe {
  const {
    laborCostCents: _labor,
    energyCostCents: _energy,
    packagingCostCents: _packaging,
    sellingPriceCents: _selling,
    ...rest
  } = row;
  return rest;
}

/** Strips all money (recipe + per-line ingredient price) for a kitchen payload. */
export function toKitchenRecipeWithIngredients(
  data: RecipeWithIngredients,
): KitchenRecipeWithIngredients {
  return {
    recipe: toKitchenRecipe(data.recipe),
    lines: data.lines.map((l) => ({
      id: l.id,
      ingredientId: l.ingredientId,
      quantity: l.quantity,
      sortOrder: l.sortOrder,
      ingredient: { name: l.ingredient.name, dimension: l.ingredient.dimension },
    })),
  };
}

/**
 * Kitchen Scale listing DTO (Kitchen Scale module): the operational, MONEY-FREE
 * shape BOTH roles receive on `/kitchen-scale`. Unlike the recipes page (which
 * strips money only for kitchen), this page never carries money for anyone, so
 * the DTO simply has no money keys.
 */
export type KitchenScaleRecipeListItem = {
  id: string;
  name: string;
  folderId: string | null;
  yieldPortions: number;
  yieldWeightGrams: number | null;
  lineCount: number;
  presetCount: number;
};

/**
 * Active recipes in the org as {@link KitchenScaleRecipeListItem}s. Three
 * org-scoped queries (recipes + grouped line counts + grouped preset counts)
 * merged in memory — no N+1, no money fields ever selected.
 */
export async function listKitchenScaleRecipes(
  db: TenantClient,
  organizationId: string,
): Promise<KitchenScaleRecipeListItem[]> {
  const recipeRows = await db
    .select({
      id: recipes.id,
      name: recipes.name,
      folderId: recipes.folderId,
      yieldPortions: recipes.yieldPortions,
      yieldWeightGrams: recipes.yieldWeightGrams,
    })
    .from(recipes)
    .where(
      and(eq(recipes.organizationId, organizationId), isNull(recipes.deletedAt)),
    )
    .orderBy(recipes.name);
  if (recipeRows.length === 0) return [];

  const [lineRows, presetRows] = await Promise.all([
    db
      .select({ recipeId: recipeIngredients.recipeId, value: count() })
      .from(recipeIngredients)
      .where(eq(recipeIngredients.organizationId, organizationId))
      .groupBy(recipeIngredients.recipeId),
    db
      .select({ recipeId: recipePresets.recipeId, value: count() })
      .from(recipePresets)
      .where(eq(recipePresets.organizationId, organizationId))
      .groupBy(recipePresets.recipeId),
  ]);
  const lineCounts = new Map(lineRows.map((r) => [r.recipeId, r.value]));
  const presetCounts = new Map(presetRows.map((r) => [r.recipeId, r.value]));

  return recipeRows.map((r) => ({
    id: r.id,
    name: r.name,
    folderId: r.folderId,
    yieldPortions: r.yieldPortions,
    yieldWeightGrams: r.yieldWeightGrams,
    lineCount: lineCounts.get(r.id) ?? 0,
    presetCount: presetCounts.get(r.id) ?? 0,
  }));
}

/**
 * Which folder view to list. `all` = every active recipe; `uncategorized` = those
 * with no folder ("No folder"); `folder` = a single folder. The folder filter is
 * additive — `deleted_at IS NULL` always applies, so trashed recipes never show.
 */
export type RecipeFilter =
  | { kind: 'all' }
  | { kind: 'uncategorized' }
  | { kind: 'folder'; folderId: string };

export async function listRecipes(
  db: TenantClient,
  organizationId: string,
  filter: RecipeFilter = { kind: 'all' },
): Promise<Recipe[]> {
  const folderCondition =
    filter.kind === 'uncategorized'
      ? isNull(recipes.folderId)
      : filter.kind === 'folder'
        ? eq(recipes.folderId, filter.folderId)
        : undefined;

  return db
    .select()
    .from(recipes)
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        isNull(recipes.deletedAt),
        // `and` ignores undefined, so `all` adds no folder constraint.
        folderCondition,
      ),
    )
    .orderBy(recipes.name);
}

/**
 * Files an ACTIVE recipe into a folder, or to "No folder" (`folderId = null`).
 * The composite (organization_id, folder_id) FK guarantees the folder is in this
 * org — a non-existent or cross-tenant folder raises a foreign-key violation the
 * action surfaces. Trashed recipes must be restored before they can be moved.
 *
 * Fase 7 coexistence (D2): the move is mirrored onto the homonymous recipe
 * BOOKS via `syncBookMembershipForFolderMove`, so folders and books keep
 * telling the same story while both organizers are live.
 */
export async function moveRecipeToFolder(
  db: TenantClient,
  organizationId: string,
  id: string,
  folderId: string | null,
): Promise<Recipe | null> {
  // The old folder's name drives the book write-through, so read it before the
  // move (both queries run inside the caller's withOrg transaction).
  const [before] = await db
    .select({ folderId: recipes.folderId })
    .from(recipes)
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        eq(recipes.id, id),
        isNull(recipes.deletedAt),
      ),
    )
    .limit(1);
  if (!before) return null;

  const [row] = await db
    .update(recipes)
    .set({ folderId })
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        eq(recipes.id, id),
        isNull(recipes.deletedAt),
      ),
    )
    .returning();
  if (!row) return null;

  await mirrorFolderChangeToBooks(db, organizationId, id, before.folderId, folderId);
  return row;
}

/**
 * Resolves the old/new folder rows by id and hands them to the homonymous-book
 * write-through (D2 coexistence). No-op when the folder did not change.
 */
async function mirrorFolderChangeToBooks(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
  oldFolderId: string | null,
  newFolderId: string | null,
): Promise<void> {
  if (oldFolderId === newFolderId) return;
  const folderIds = [oldFolderId, newFolderId].filter(
    (f): f is string => f !== null,
  );
  const folderRows = folderIds.length
    ? await db
        .select({
          id: recipeFolders.id,
          name: recipeFolders.name,
          icon: recipeFolders.icon,
        })
        .from(recipeFolders)
        .where(
          and(
            eq(recipeFolders.organizationId, organizationId),
            inArray(recipeFolders.id, folderIds),
          ),
        )
    : [];
  const byId = new Map(folderRows.map((f) => [f.id, f]));
  await syncBookMembershipForFolderMove(
    db,
    organizationId,
    recipeId,
    oldFolderId ? (byId.get(oldFolderId) ?? null) : null,
    newFolderId ? (byId.get(newFolderId) ?? null) : null,
  );
}

/**
 * Every active recipe in the org, each with its ingredient lines — for aggregate
 * views (the dashboard) that need to cost the whole catalogue at once. Two
 * org-scoped queries (recipes, then all their lines) grouped in memory, so there
 * is no N+1. The ingredient join is deliberately NOT filtered by `deleted_at`:
 * the invariant (an active recipe never references a trashed ingredient) keeps
 * referenced ingredients live, and filtering here would silently drop a line and
 * change the recipe cost.
 */
export async function listRecipesWithLines(
  db: TenantClient,
  organizationId: string,
): Promise<RecipeWithIngredients[]> {
  const recipeRows = await listRecipes(db, organizationId);
  if (recipeRows.length === 0) return [];

  const lineRows = await db
    .select({
      id: recipeIngredients.id,
      recipeId: recipeIngredients.recipeId,
      ingredientId: recipeIngredients.ingredientId,
      quantity: recipeIngredients.quantity,
      sortOrder: recipeIngredients.sortOrder,
      prepYieldBps: ingredientPrepActions.yieldBps,
      name: ingredients.name,
      dimension: ingredients.dimension,
      priceCents: ingredients.priceCents,
    })
    .from(recipeIngredients)
    .innerJoin(
      ingredients,
      and(
        eq(recipeIngredients.ingredientId, ingredients.id),
        eq(ingredients.organizationId, organizationId),
      ),
    )
    .leftJoin(
      ingredientPrepActions,
      and(
        eq(ingredientPrepActions.organizationId, organizationId),
        eq(ingredientPrepActions.id, recipeIngredients.prepActionId),
      ),
    )
    .where(eq(recipeIngredients.organizationId, organizationId))
    .orderBy(recipeIngredients.sortOrder);

  const linesByRecipe = new Map<string, RecipeLineWithIngredient[]>();
  for (const r of lineRows) {
    const line: RecipeLineWithIngredient = {
      id: r.id,
      ingredientId: r.ingredientId,
      // numeric columns come back as strings — convert at the data edge.
      quantity: Number(r.quantity),
      sortOrder: r.sortOrder,
      prepYieldBps: r.prepYieldBps,
      ingredient: {
        name: r.name,
        dimension: r.dimension,
        priceCents: r.priceCents,
      },
    };
    const existing = linesByRecipe.get(r.recipeId);
    if (existing) existing.push(line);
    else linesByRecipe.set(r.recipeId, [line]);
  }

  // recipeRows are active only, so lines of trashed recipes (if any) are ignored.
  return recipeRows.map((recipe) => ({
    recipe,
    lines: linesByRecipe.get(recipe.id) ?? [],
  }));
}

export async function getRecipeById(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Recipe | null> {
  const rows = await db
    .select()
    .from(recipes)
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        eq(recipes.id, id),
        isNull(recipes.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * A recipe plus its lines, each joined with the ingredient's name, dimension and
 * current price — everything the cost calculation and editor need. Org-scoped on
 * both tables; the composite FK already guarantees same-tenant links. The
 * ingredient join is intentionally not filtered by `deleted_at` (see
 * listRecipesWithLines).
 */
export async function getRecipeWithIngredients(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<RecipeWithIngredients | null> {
  const recipe = await getRecipeById(db, organizationId, id);
  if (!recipe) return null;

  const rows = await db
    .select({
      id: recipeIngredients.id,
      ingredientId: recipeIngredients.ingredientId,
      quantity: recipeIngredients.quantity,
      sortOrder: recipeIngredients.sortOrder,
      prepYieldBps: ingredientPrepActions.yieldBps,
      name: ingredients.name,
      dimension: ingredients.dimension,
      priceCents: ingredients.priceCents,
    })
    .from(recipeIngredients)
    .innerJoin(
      ingredients,
      and(
        eq(recipeIngredients.ingredientId, ingredients.id),
        eq(ingredients.organizationId, organizationId),
      ),
    )
    .leftJoin(
      ingredientPrepActions,
      and(
        eq(ingredientPrepActions.organizationId, organizationId),
        eq(ingredientPrepActions.id, recipeIngredients.prepActionId),
      ),
    )
    .where(
      and(
        eq(recipeIngredients.organizationId, organizationId),
        eq(recipeIngredients.recipeId, id),
      ),
    )
    .orderBy(recipeIngredients.sortOrder);

  const lines: RecipeLineWithIngredient[] = rows.map((r) => ({
    id: r.id,
    ingredientId: r.ingredientId,
    // numeric columns come back as strings — convert at the data edge.
    quantity: Number(r.quantity),
    sortOrder: r.sortOrder,
    prepYieldBps: r.prepYieldBps,
    ingredient: {
      name: r.name,
      dimension: r.dimension,
      priceCents: r.priceCents,
    },
  }));

  return { recipe, lines };
}

/**
 * How many ACTIVE (non-trashed) recipes the org currently has. Drives the
 * Starter plan's recipe cap (Sprint 4): `createRecipeAction` reads this inside
 * the same `withOrg` transaction as the insert, so the count + cap check + write
 * are one RLS-scoped unit and the limit can't be raced past by a hair. Trashed
 * recipes don't count against the cap (they're restorable, not live).
 */
export async function countActiveRecipes(
  db: TenantClient,
  organizationId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(recipes)
    .where(
      and(eq(recipes.organizationId, organizationId), isNull(recipes.deletedAt)),
    );
  return rows[0]?.value ?? 0;
}

export async function createRecipe(
  db: TenantClient,
  organizationId: string,
  input: RecipeInput,
): Promise<Recipe> {
  const [row] = await db
    .insert(recipes)
    .values({ ...input, organizationId })
    .returning();
  if (!row) throw new Error('Failed to create recipe.');
  if (row.folderId) {
    await mirrorFolderChangeToBooks(db, organizationId, row.id, null, row.folderId);
  }
  return row;
}

export async function updateRecipe(
  db: TenantClient,
  organizationId: string,
  id: string,
  input: RecipeInput,
): Promise<Recipe | null> {
  // The legacy editor changes `folderId` through here too — read the previous
  // value so the homonymous-book write-through can mirror the change (D2).
  const [before] = await db
    .select({ folderId: recipes.folderId })
    .from(recipes)
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        eq(recipes.id, id),
        isNull(recipes.deletedAt),
      ),
    )
    .limit(1);
  if (!before) return null;

  const [row] = await db
    .update(recipes)
    .set(input)
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        eq(recipes.id, id),
        // A trashed recipe must be restored before it can be edited.
        isNull(recipes.deletedAt),
      ),
    )
    .returning();
  if (!row) return null;

  if (input.folderId !== undefined) {
    await mirrorFolderChangeToBooks(
      db,
      organizationId,
      id,
      before.folderId,
      row.folderId,
    );
  }
  return row;
}

/**
 * How many of this recipe's ingredients are currently trashed. The trash action
 * blocks restoring a recipe while this is > 0 (the user must restore those
 * ingredients first), upholding the active-recipe-never-references-trashed-
 * ingredient invariant.
 */
export async function countTrashedIngredientsInRecipe(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
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
        eq(recipeIngredients.recipeId, recipeId),
        isNotNull(ingredients.deletedAt),
      ),
    );
  return rows[0]?.value ?? 0;
}

/**
 * Locks (FOR UPDATE) every ingredient row this recipe references, in a stable id
 * order. `restoreRecipeAction` takes these locks before its trashed-ingredient
 * check + restore, so a concurrent ingredient trash (which locks the same rows)
 * can't interleave and leave the freshly-restored active recipe pointing at a
 * trashed ingredient. Ordering by id keeps two such transactions deadlock-free.
 */
export async function lockRecipeReferencedIngredients(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
): Promise<void> {
  await db
    .select({ id: ingredients.id })
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
        eq(recipeIngredients.recipeId, recipeId),
      ),
    )
    .orderBy(ingredients.id)
    .for('update', { of: ingredients });
}

/** Moves an active recipe to the trash. Returns null if it was not active. */
export async function softDeleteRecipe(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Recipe | null> {
  const [row] = await db
    .update(recipes)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        eq(recipes.id, id),
        isNull(recipes.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/** Brings a trashed recipe back. Returns null if it was not in the trash. */
export async function restoreRecipe(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Recipe | null> {
  const [row] = await db
    .update(recipes)
    .set({ deletedAt: null })
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        eq(recipes.id, id),
        isNotNull(recipes.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Permanently deletes a trashed recipe; its lines cascade via the composite FK.
 * Only trashed rows are eligible (an active recipe can never be hard-deleted here).
 *
 * Any transaction that referenced this recipe is unlinked first (`recipe_id` →
 * NULL): the `transactions_recipe_fk` is `ON DELETE restrict`, so a referencing
 * transaction would otherwise block the purge. The financial record survives with
 * no recipe link. Runs in the caller's `withOrg` transaction, so it is atomic.
 */
export async function purgeRecipe(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<void> {
  await db
    .update(transactions)
    .set({ recipeId: null })
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        eq(transactions.recipeId, id),
      ),
    );

  // Null any prep-task link pointing at this recipe (→ plain text) before the delete,
  // so the `tasks_source_recipe_fk` restrict FK never blocks (Sprint 6 L4). Reached
  // only after the menu/production guards pass (purgeRecipeWithGuards), so a blocked
  // purge never nulls a task link.
  await nullTaskRecipeLinks(db, organizationId, [id]);

  await db
    .delete(recipes)
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        eq(recipes.id, id),
        isNotNull(recipes.deletedAt),
      ),
    );
}

export async function listTrashedRecipes(
  db: TenantClient,
  organizationId: string,
): Promise<Recipe[]> {
  return db
    .select()
    .from(recipes)
    .where(
      and(eq(recipes.organizationId, organizationId), isNotNull(recipes.deletedAt)),
    )
    .orderBy(desc(recipes.deletedAt));
}
