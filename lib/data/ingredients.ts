import { and, eq } from 'drizzle-orm';
import { ingredients } from '@/lib/db/schema';
import type { Ingredient, NewIngredient } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';

/**
 * Access to `ingredients` is ALWAYS scoped by `organizationId` (application
 * layer, primary defense). The `organizationId` is injected by the server —
 * never trust the client. RLS (lib/db/rls.ts) is the second layer.
 */

export type IngredientInput = Omit<
  NewIngredient,
  'id' | 'organizationId' | 'createdAt' | 'updatedAt'
>;

export async function listIngredients(
  db: TenantClient,
  organizationId: string,
): Promise<Ingredient[]> {
  return db
    .select()
    .from(ingredients)
    .where(eq(ingredients.organizationId, organizationId))
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
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Deletes an ingredient. The composite FK on `recipe_ingredients` is
 * `ON DELETE restrict`, so an ingredient still used by a recipe makes the DB
 * raise a foreign-key violation — callers surface that as a friendly message.
 */
export async function deleteIngredient(
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
      ),
    );
}
