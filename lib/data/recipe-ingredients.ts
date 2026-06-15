import { and, eq } from 'drizzle-orm';
import { recipeIngredients } from '@/lib/db/schema';
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

export async function addRecipeIngredient(
  db: TenantClient,
  organizationId: string,
  input: AddRecipeIngredientInput,
): Promise<RecipeIngredient> {
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
  return row;
}

export async function updateRecipeIngredient(
  db: TenantClient,
  organizationId: string,
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
      ),
    )
    .returning();
  return row ?? null;
}

export async function removeRecipeIngredient(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<void> {
  await db
    .delete(recipeIngredients)
    .where(
      and(
        eq(recipeIngredients.organizationId, organizationId),
        eq(recipeIngredients.id, id),
      ),
    );
}
