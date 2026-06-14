import { and, eq } from 'drizzle-orm';
import { recipes } from '@/lib/db/schema';
import type { Recipe, NewRecipe } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';

/** Access to `recipes` is ALWAYS scoped by `organizationId`. See lib/data/ingredients.ts. */

export type RecipeInput = Omit<
  NewRecipe,
  'id' | 'organizationId' | 'createdAt' | 'updatedAt'
>;

export async function listRecipes(
  db: TenantClient,
  organizationId: string,
): Promise<Recipe[]> {
  return db
    .select()
    .from(recipes)
    .where(eq(recipes.organizationId, organizationId))
    .orderBy(recipes.name);
}

export async function getRecipeById(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Recipe | null> {
  const rows = await db
    .select()
    .from(recipes)
    .where(and(eq(recipes.organizationId, organizationId), eq(recipes.id, id)))
    .limit(1);
  return rows[0] ?? null;
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
  return row;
}
