import { and, count, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import { recipePresets, recipes } from '@/lib/db/schema';
import type { RecipePreset } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { MAX_RECIPE_PRESETS } from '@/lib/validation/recipe-presets';

/**
 * Kitchen presets (Recipe-editor parity), ALWAYS scoped by `organizationId`
 * (RULE #1) — derived on the server, never trusted from the client; RLS is the
 * second layer. The composite (organization_id, recipe_id) FK additionally forces
 * a preset and its recipe to share this row's org (cross-tenant links are
 * impossible at the DB level).
 *
 * A preset is OPERATIONAL config (a named target finished weight) — both manager
 * and kitchen manage name + weight, and NO money column lives here. Mutations only
 * apply to ACTIVE parent recipes; per-recipe name uniqueness is case-insensitive
 * (DB functional unique index + the explicit pre-checks below for clean outcomes).
 */

export type PresetInput = { name: string; targetWeightGrams: number };

export async function listRecipePresets(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
): Promise<RecipePreset[]> {
  return db
    .select()
    .from(recipePresets)
    .where(
      and(
        eq(recipePresets.organizationId, organizationId),
        eq(recipePresets.recipeId, recipeId),
      ),
    )
    .orderBy(recipePresets.sortOrder, recipePresets.name);
}

/** Confirms the parent recipe is ACTIVE and in this org (the mutation guard). */
async function parentRecipeIsActive(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
): Promise<boolean> {
  const [recipe] = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        eq(recipes.id, recipeId),
        isNull(recipes.deletedAt),
      ),
    )
    .limit(1);
  return Boolean(recipe);
}

/**
 * True iff `name` already exists for this recipe (case-insensitive), ignoring
 * `excludeId` (so a self-rename to the same casing is not a "duplicate"). The DB
 * functional unique index is the authoritative backstop; this gives the action a
 * clean DUPLICATE_NAME outcome without aborting the transaction on a constraint hit.
 */
async function nameTaken(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: recipePresets.id })
    .from(recipePresets)
    .where(
      and(
        eq(recipePresets.organizationId, organizationId),
        eq(recipePresets.recipeId, recipeId),
        sql`lower(${recipePresets.name}) = lower(${name})`,
      ),
    );
  return rows.some((r) => r.id !== excludeId);
}

export type AddRecipePresetOutcome =
  | { status: 'ok'; row: RecipePreset }
  | { status: 'recipe_not_active' }
  | { status: 'duplicate' }
  | { status: 'limit_reached' };

/**
 * Adds a preset at the END of the recipe's list. `sort_order` = (current max) + 1 so
 * positions stay distinct/append-only. Rejects a trashed/missing recipe, a duplicate
 * (case-insensitive) name, or exceeding {@link MAX_RECIPE_PRESETS}. Runs in the
 * caller's `withOrg` transaction.
 */
export async function addRecipePreset(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
  input: PresetInput,
): Promise<AddRecipePresetOutcome> {
  if (!(await parentRecipeIsActive(db, organizationId, recipeId))) {
    return { status: 'recipe_not_active' };
  }

  const [countRow] = await db
    .select({ value: count() })
    .from(recipePresets)
    .where(
      and(
        eq(recipePresets.organizationId, organizationId),
        eq(recipePresets.recipeId, recipeId),
      ),
    );
  if ((countRow?.value ?? 0) >= MAX_RECIPE_PRESETS) {
    return { status: 'limit_reached' };
  }

  if (await nameTaken(db, organizationId, recipeId, input.name)) {
    return { status: 'duplicate' };
  }

  const [maxRow] = await db
    .select({ value: max(recipePresets.sortOrder) })
    .from(recipePresets)
    .where(
      and(
        eq(recipePresets.organizationId, organizationId),
        eq(recipePresets.recipeId, recipeId),
      ),
    );
  const nextOrder = maxRow?.value == null ? 0 : maxRow.value + 1;

  const [row] = await db
    .insert(recipePresets)
    .values({
      organizationId,
      recipeId,
      name: input.name,
      targetWeightGrams: input.targetWeightGrams,
      sortOrder: nextOrder,
    })
    .returning();
  if (!row) throw new Error('Failed to add recipe preset.');
  return { status: 'ok', row };
}

export type UpdateRecipePresetOutcome =
  | { status: 'ok'; row: RecipePreset }
  | { status: 'not_found' }
  | { status: 'duplicate' };

/**
 * Renames a preset and/or resets its target weight. Returns `not_found` for a
 * trashed/missing recipe or a forged preset id; `duplicate` for a case-insensitive
 * name clash with a SIBLING preset. Runs in the caller's `withOrg` transaction.
 */
export async function updateRecipePreset(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
  presetId: string,
  input: PresetInput,
): Promise<UpdateRecipePresetOutcome> {
  if (!(await parentRecipeIsActive(db, organizationId, recipeId))) {
    return { status: 'not_found' };
  }

  const [existing] = await db
    .select({ id: recipePresets.id })
    .from(recipePresets)
    .where(
      and(
        eq(recipePresets.organizationId, organizationId),
        eq(recipePresets.recipeId, recipeId),
        eq(recipePresets.id, presetId),
      ),
    )
    .limit(1);
  if (!existing) return { status: 'not_found' };

  if (await nameTaken(db, organizationId, recipeId, input.name, presetId)) {
    return { status: 'duplicate' };
  }

  const [row] = await db
    .update(recipePresets)
    .set({ name: input.name, targetWeightGrams: input.targetWeightGrams })
    .where(
      and(
        eq(recipePresets.organizationId, organizationId),
        eq(recipePresets.recipeId, recipeId),
        eq(recipePresets.id, presetId),
      ),
    )
    .returning();
  if (!row) return { status: 'not_found' };
  return { status: 'ok', row };
}

/** Returns true iff a preset was actually removed (same-org, matching recipe + id). */
export async function removeRecipePreset(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
  presetId: string,
): Promise<boolean> {
  const removed = await db
    .delete(recipePresets)
    .where(
      and(
        eq(recipePresets.organizationId, organizationId),
        eq(recipePresets.recipeId, recipeId),
        eq(recipePresets.id, presetId),
      ),
    )
    .returning({ id: recipePresets.id });
  return removed.length > 0;
}

export type ReorderRecipePresetsOutcome =
  | { status: 'ok'; count: number }
  | { status: 'not_found' }
  | { status: 'stale' };

/**
 * Atomically renumber a recipe's presets to `orderedPresetIds` (index → `sort_order`).
 * Mirrors {@link reorderRecipeIngredients}: lock the current rows `FOR UPDATE` in a
 * deterministic id order, require an EXACT set match (same size, every requested id
 * present, no duplicates — so a partial/foreign/removed id or a concurrent add/remove
 * returns `stale` and writes nothing), then renumber. Runs in the caller's `withOrg`
 * transaction.
 */
export async function reorderRecipePresets(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
  orderedPresetIds: string[],
): Promise<ReorderRecipePresetsOutcome> {
  if (!(await parentRecipeIsActive(db, organizationId, recipeId))) {
    return { status: 'not_found' };
  }

  const current = await db
    .select({ id: recipePresets.id })
    .from(recipePresets)
    .where(
      and(
        eq(recipePresets.organizationId, organizationId),
        eq(recipePresets.recipeId, recipeId),
      ),
    )
    .orderBy(recipePresets.id)
    .for('update');

  const requested = new Set(orderedPresetIds);
  if (requested.size !== orderedPresetIds.length) return { status: 'stale' };
  const currentIds = new Set(current.map((r) => r.id));
  if (requested.size !== currentIds.size) return { status: 'stale' };
  for (const presetId of requested) {
    if (!currentIds.has(presetId)) return { status: 'stale' };
  }

  for (let i = 0; i < orderedPresetIds.length; i += 1) {
    await db
      .update(recipePresets)
      .set({ sortOrder: i })
      .where(
        and(
          eq(recipePresets.organizationId, organizationId),
          eq(recipePresets.recipeId, recipeId),
          eq(recipePresets.id, orderedPresetIds[i]!),
        ),
      );
  }
  return { status: 'ok', count: orderedPresetIds.length };
}

export type SyncRecipePresetsOutcome =
  | { status: 'ok'; added: number; updated: number; removed: number }
  | { status: 'not_found' }
  | { status: 'duplicate' }
  | { status: 'limit_reached' };

/**
 * Replaces a recipe's presets with `drafts` (the recipe editor saves them with the
 * rest of the recipe, in one transaction). Array position becomes `sort_order`; a
 * preset with an `id` is updated in place (ids stay stable for Kitchen Scale prep-card
 * links), one without is inserted, and a stored preset absent from the list is
 * removed. Unknown/foreign ids are `not_found` and nothing is written. Renames run in
 * two phases so swapping two names never trips the case-insensitive unique index.
 * Runs in the caller's `withOrg` transaction, after the parent recipe is locked.
 */
export async function syncRecipePresets(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
  drafts: (PresetInput & { id?: string })[],
): Promise<SyncRecipePresetsOutcome> {
  if (drafts.length > MAX_RECIPE_PRESETS) return { status: 'limit_reached' };
  const lowerNames = new Set(drafts.map((d) => d.name.toLowerCase()));
  if (lowerNames.size !== drafts.length) return { status: 'duplicate' };
  if (!(await parentRecipeIsActive(db, organizationId, recipeId))) {
    return { status: 'not_found' };
  }

  const current = await db
    .select({
      id: recipePresets.id,
      name: recipePresets.name,
      targetWeightGrams: recipePresets.targetWeightGrams,
      sortOrder: recipePresets.sortOrder,
    })
    .from(recipePresets)
    .where(
      and(
        eq(recipePresets.organizationId, organizationId),
        eq(recipePresets.recipeId, recipeId),
      ),
    )
    .orderBy(recipePresets.id)
    .for('update');
  const currentById = new Map(current.map((p) => [p.id, p]));

  const keptIds = new Set<string>();
  for (const draft of drafts) {
    if (draft.id === undefined) continue;
    if (!currentById.has(draft.id) || keptIds.has(draft.id)) return { status: 'not_found' };
    keptIds.add(draft.id);
  }

  const removedIds = current.filter((p) => !keptIds.has(p.id)).map((p) => p.id);
  if (removedIds.length > 0) {
    await db
      .delete(recipePresets)
      .where(
        and(
          eq(recipePresets.organizationId, organizationId),
          eq(recipePresets.recipeId, recipeId),
          inArray(recipePresets.id, removedIds),
        ),
      );
  }

  // Phase 1: park every renamed preset on a name unique to its id.
  const renamed = drafts.filter(
    (d) => d.id !== undefined && currentById.get(d.id)!.name !== d.name,
  );
  for (const draft of renamed) {
    await db
      .update(recipePresets)
      .set({ name: `\u0001${draft.id}` })
      .where(
        and(
          eq(recipePresets.organizationId, organizationId),
          eq(recipePresets.recipeId, recipeId),
          eq(recipePresets.id, draft.id!),
        ),
      );
  }

  // Phase 2: final names, weights and order.
  let added = 0;
  let updated = 0;
  for (const [index, draft] of drafts.entries()) {
    if (draft.id === undefined) {
      await db.insert(recipePresets).values({
        organizationId,
        recipeId,
        name: draft.name,
        targetWeightGrams: draft.targetWeightGrams,
        sortOrder: index,
      });
      added += 1;
      continue;
    }
    const before = currentById.get(draft.id)!;
    if (
      before.name === draft.name &&
      Number(before.targetWeightGrams) === draft.targetWeightGrams &&
      before.sortOrder === index
    ) {
      continue;
    }
    await db
      .update(recipePresets)
      .set({ name: draft.name, targetWeightGrams: draft.targetWeightGrams, sortOrder: index })
      .where(
        and(
          eq(recipePresets.organizationId, organizationId),
          eq(recipePresets.recipeId, recipeId),
          eq(recipePresets.id, draft.id),
        ),
      );
    updated += 1;
  }
  return { status: 'ok', added, updated, removed: removedIds.length };
}
