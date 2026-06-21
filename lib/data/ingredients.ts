import { and, count, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { ingredients, recipeIngredients, recipes } from '@/lib/db/schema';
import type { Ingredient, NewIngredient } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';

/**
 * Access to `ingredients` is ALWAYS scoped by `organizationId` (application
 * layer, primary defense). The `organizationId` is injected by the server —
 * never trust the client. RLS (lib/db/rls.ts) is the second layer.
 *
 * Soft-delete: rows carry `deleted_at` (NULL = active). Every active read filters
 * `deleted_at IS NULL`; trashed rows surface only through the trash-scoped reads
 * below. See lib/trash.ts for the retention window and lib/data/trash.ts for the
 * auto-purge.
 */

export type IngredientInput = Omit<
  NewIngredient,
  'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export async function listIngredients(
  db: TenantClient,
  organizationId: string,
): Promise<Ingredient[]> {
  return db
    .select()
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        isNull(ingredients.deletedAt),
      ),
    )
    .orderBy(ingredients.name);
}

export async function getIngredientById(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Ingredient | null> {
  const rows = await db
    .select()
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, id),
        isNull(ingredients.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function createIngredient(
  db: TenantClient,
  organizationId: string,
  input: IngredientInput,
): Promise<Ingredient> {
  const [row] = await db
    .insert(ingredients)
    .values({ ...input, organizationId })
    .returning();
  if (!row) throw new Error('Failed to create ingredient.');
  return row;
}

export async function updateIngredient(
  db: TenantClient,
  organizationId: string,
  id: string,
  input: IngredientInput,
): Promise<Ingredient | null> {
  const [row] = await db
    .update(ingredients)
    .set(input)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, id),
        // A trashed ingredient must be restored before it can be edited.
        isNull(ingredients.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * How many ACTIVE (non-trashed) recipes still use this ingredient. The trash
 * action blocks soft-deleting an ingredient while this is > 0, preserving the
 * invariant that an active recipe never references a trashed ingredient (so
 * recipe costs never change silently). Lines of already-trashed recipes do not
 * count.
 */
export async function countActiveRecipesUsingIngredient(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(recipeIngredients)
    .innerJoin(
      recipes,
      and(
        eq(recipeIngredients.recipeId, recipes.id),
        eq(recipes.organizationId, organizationId),
      ),
    )
    .where(
      and(
        eq(recipeIngredients.organizationId, organizationId),
        eq(recipeIngredients.ingredientId, ingredientId),
        isNull(recipes.deletedAt),
      ),
    );
  return rows[0]?.value ?? 0;
}

/**
 * Takes a FOR UPDATE lock on an active ingredient row, returning whether one
 * exists. `deleteIngredientAction` calls this before its in-use check, and
 * `addRecipeIngredient` locks the same row before wiring a line — so the two
 * flows serialize on this row and the "active recipe references only active
 * ingredients" invariant can't be raced under READ COMMITTED.
 */
export async function lockActiveIngredient(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: ingredients.id })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, id),
        isNull(ingredients.deletedAt),
      ),
    )
    .for('update')
    .limit(1);
  return rows.length > 0;
}

/**
 * Like {@link lockActiveIngredient}, but returns the FULL locked row (or null).
 * The F2 pricing flows (record observation / accept cost / manual price edit) take
 * this FOR UPDATE lock so they serialize on the ingredient — a concurrent observe
 * and accept can't race and accept the wrong "latest" history line.
 */
export async function lockActiveIngredientRow(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Ingredient | null> {
  const rows = await db
    .select()
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, id),
        isNull(ingredients.deletedAt),
      ),
    )
    .for('update')
    .limit(1);
  return rows[0] ?? null;
}

/** Moves an active ingredient to the trash. Returns null if it was not active. */
export async function softDeleteIngredient(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Ingredient | null> {
  const [row] = await db
    .update(ingredients)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, id),
        isNull(ingredients.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/** Outcome of {@link trashIngredient}. */
export type TrashIngredientOutcome =
  | { status: 'done' }
  | { status: 'in_use'; inUse: number }
  | { status: 'not_found' };

/**
 * The full "move an ingredient to the trash" transaction, as a data-layer service
 * so it is testable without Clerk/cache (deleteIngredientAction is a thin wrapper).
 * MUST run inside a `withOrg`/`runInOrg` transaction: it locks the active row FOR
 * UPDATE, refuses if any ACTIVE recipe still uses it, then soft-deletes — all
 * serialized against `addRecipeIngredient` (which takes the same lock), so the
 * active-recipe-references-only-active-ingredient invariant holds under real
 * Postgres concurrency.
 */
export async function trashIngredient(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<TrashIngredientOutcome> {
  if (!(await lockActiveIngredient(db, organizationId, id))) {
    return { status: 'not_found' };
  }
  const inUse = await countActiveRecipesUsingIngredient(db, organizationId, id);
  if (inUse > 0) return { status: 'in_use', inUse };
  const row = await softDeleteIngredient(db, organizationId, id);
  return row ? { status: 'done' } : { status: 'not_found' };
}

/** Brings a trashed ingredient back. Returns null if it was not in the trash. */
export async function restoreIngredient(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Ingredient | null> {
  const [row] = await db
    .update(ingredients)
    .set({ deletedAt: null })
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, id),
        isNotNull(ingredients.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Permanently deletes a trashed ingredient. Only trashed rows are eligible (an
 * active row can never be hard-deleted here). The composite FK on
 * `recipe_ingredients` is `ON DELETE restrict`, so an ingredient still pinned by
 * a (trashed) recipe's line raises a foreign-key violation — callers surface that.
 */
export async function purgeIngredient(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<void> {
  await db
    .delete(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, id),
        isNotNull(ingredients.deletedAt),
      ),
    );
}

export async function listTrashedIngredients(
  db: TenantClient,
  organizationId: string,
): Promise<Ingredient[]> {
  return db
    .select()
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        isNotNull(ingredients.deletedAt),
      ),
    )
    .orderBy(desc(ingredients.deletedAt));
}
