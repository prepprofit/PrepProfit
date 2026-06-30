import { and, eq, exists, isNull, sql } from 'drizzle-orm';
import { ingredients, recipeIngredients, recipes } from '@/lib/db/schema';
import type { RecipeIngredient } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';

/**
 * Recipe lines, ALWAYS scoped by `organizationId`. The composite FKs on
 * recipe_ingredients additionally force the referenced recipe and ingredient to
 * share this row's org (cross-tenant links are impossible at the DB level).
 * `quantity` is canonical (g / ml / count); numeric columns are stored as strings.
 */

export type AddRecipeIngredientInput = {
  recipeId: string;
  ingredientId: string;
  quantity: number;
  sortOrder?: number;
};

export type AddRecipeIngredientResult =
  | { ok: true; row: RecipeIngredient }
  | { ok: false; reason: 'recipe_not_active' | 'ingredient_trashed' };

export async function addRecipeIngredient(
  db: TenantClient,
  organizationId: string,
  input: AddRecipeIngredientInput,
): Promise<AddRecipeIngredientResult> {
  // The composite FKs already force same-org links, but they do NOT see
  // soft-delete state. Refuse to add to a trashed recipe, or to wire a trashed
  // ingredient into an active recipe, so the invariant other code relies on —
  // "an active recipe line references only active rows" — always holds.
  const [recipe] = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        eq(recipes.id, input.recipeId),
        isNull(recipes.deletedAt),
      ),
    )
    .limit(1);
  if (!recipe) return { ok: false, reason: 'recipe_not_active' };

  // Lock the ingredient row FOR UPDATE before inserting the line. The trash and
  // restore flows (deleteIngredientAction, restoreRecipeAction) take the same
  // lock, so a concurrent "trash this ingredient" can't slip its in-use check
  // between this read and the insert under READ COMMITTED — which would otherwise
  // leave an active recipe pointing at a trashed ingredient.
  const [ingredient] = await db
    .select({ id: ingredients.id })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, input.ingredientId),
        isNull(ingredients.deletedAt),
      ),
    )
    .for('update')
    .limit(1);
  if (!ingredient) return { ok: false, reason: 'ingredient_trashed' };

  const [row] = await db
    .insert(recipeIngredients)
    .values({
      organizationId,
      recipeId: input.recipeId,
      ingredientId: input.ingredientId,
      quantity: input.quantity.toString(),
      sortOrder: input.sortOrder ?? 0,
    })
    .returning();
  if (!row) throw new Error('Failed to add ingredient to recipe.');
  return { ok: true, row };
}

/**
 * EXISTS guard: the parent recipe (`recipeId`) is ACTIVE and in this org. Combined
 * with `recipe_id = recipeId` on the line, a forged line id that belongs to a
 * trashed recipe — or to a different recipe — matches no row, so update/remove are
 * no-ops returning "not found". This upholds the "active recipe lines reference
 * only active rows" invariant against forged ids (the add/trash/restore locks
 * handle the concurrent case).
 */
function parentRecipeIsActive(db: TenantClient, organizationId: string, recipeId: string) {
  return exists(
    db
      .select({ one: sql`1` })
      .from(recipes)
      .where(
        and(
          eq(recipes.organizationId, organizationId),
          eq(recipes.id, recipeId),
          isNull(recipes.deletedAt),
        ),
      ),
  );
}

export async function updateRecipeIngredient(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
  id: string,
  input: { quantity: number; sortOrder?: number },
): Promise<RecipeIngredient | null> {
  const set: { quantity: string; sortOrder?: number } = {
    quantity: input.quantity.toString(),
  };
  if (input.sortOrder !== undefined) set.sortOrder = input.sortOrder;

  const [row] = await db
    .update(recipeIngredients)
    .set(set)
    .where(
      and(
        eq(recipeIngredients.organizationId, organizationId),
        eq(recipeIngredients.id, id),
        eq(recipeIngredients.recipeId, recipeId),
        parentRecipeIsActive(db, organizationId, recipeId),
      ),
    )
    .returning();
  return row ?? null;
}

export type ReorderRecipeIngredientsOutcome =
  | { status: 'ok'; count: number }
  | { status: 'not_found' }
  | { status: 'stale' };

/**
 * Atomically renumber a recipe's lines to `orderedLineIds` (index → `sort_order`).
 * Runs inside the caller's `withOrg` transaction so the lock + check + writes are
 * one RLS-scoped unit. A dedicated batch function (not N client calls) so there is
 * no partial-persist failure mode and one revalidation.
 *
 * 1. Parent recipe must be ACTIVE and in this org (else `not_found`).
 * 2. Lock the recipe's current lines `FOR UPDATE` in deterministic id order, so a
 *    concurrent add/remove serializes behind us (and two reorders can't deadlock).
 * 3. Require an EXACT set match between the locked current ids and the requested
 *    ids — same size, every requested id present, no duplicates. Anything else
 *    (partial payload, foreign/removed id, a line added/removed since page load)
 *    returns `stale` and writes nothing.
 * 4. Renumber sequentially.
 */
export async function reorderRecipeIngredients(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
  orderedLineIds: string[],
): Promise<ReorderRecipeIngredientsOutcome> {
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
  if (!recipe) return { status: 'not_found' };

  const current = await db
    .select({ id: recipeIngredients.id })
    .from(recipeIngredients)
    .where(
      and(
        eq(recipeIngredients.organizationId, organizationId),
        eq(recipeIngredients.recipeId, recipeId),
      ),
    )
    .orderBy(recipeIngredients.id)
    .for('update');

  // Exact-set check (defends against duplicates too, so it is correct even if a
  // caller bypasses the Zod boundary).
  const requested = new Set(orderedLineIds);
  if (requested.size !== orderedLineIds.length) return { status: 'stale' };
  const currentIds = new Set(current.map((r) => r.id));
  if (requested.size !== currentIds.size) return { status: 'stale' };
  for (const lineId of requested) {
    if (!currentIds.has(lineId)) return { status: 'stale' };
  }

  for (let i = 0; i < orderedLineIds.length; i += 1) {
    await db
      .update(recipeIngredients)
      .set({ sortOrder: i })
      .where(
        and(
          eq(recipeIngredients.organizationId, organizationId),
          eq(recipeIngredients.recipeId, recipeId),
          eq(recipeIngredients.id, orderedLineIds[i]!),
        ),
      );
  }
  return { status: 'ok', count: orderedLineIds.length };
}

/** Returns true iff a line was actually removed (active same-org recipe, matching id). */
export async function removeRecipeIngredient(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
  id: string,
): Promise<boolean> {
  const removed = await db
    .delete(recipeIngredients)
    .where(
      and(
        eq(recipeIngredients.organizationId, organizationId),
        eq(recipeIngredients.id, id),
        eq(recipeIngredients.recipeId, recipeId),
        parentRecipeIsActive(db, organizationId, recipeId),
      ),
    )
    .returning({ id: recipeIngredients.id });
  return removed.length > 0;
}
