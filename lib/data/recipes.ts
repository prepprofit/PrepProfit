import { and, eq } from 'drizzle-orm';
import { ingredients, recipeIngredients, recipes } from '@/lib/db/schema';
import type { Ingredient, Recipe, NewRecipe } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';

/** Access to `recipes` is ALWAYS scoped by `organizationId`. See lib/data/ingredients.ts. */

export type RecipeInput = Omit<
  NewRecipe,
  'id' | 'organizationId' | 'createdAt' | 'updatedAt'
>;

/** A recipe line joined with the ingredient detail needed for cost + display. */
export type RecipeLineWithIngredient = {
  id: string;
  ingredientId: string;
  /** Canonical amount (g / ml / count). */
  quantity: number;
  sortOrder: number;
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

/**
 * A recipe plus its lines, each joined with the ingredient's name, dimension and
 * current price — everything the cost calculation and editor need. Org-scoped on
 * both tables; the composite FK already guarantees same-tenant links.
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
    ingredient: {
      name: r.name,
      dimension: r.dimension,
      priceCents: r.priceCents,
    },
  }));

  return { recipe, lines };
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

export async function updateRecipe(
  db: TenantClient,
  organizationId: string,
  id: string,
  input: RecipeInput,
): Promise<Recipe | null> {
  const [row] = await db
    .update(recipes)
    .set(input)
    .where(and(eq(recipes.organizationId, organizationId), eq(recipes.id, id)))
    .returning();
  return row ?? null;
}

/** Deletes a recipe; its lines cascade via the composite FK. */
export async function deleteRecipe(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<void> {
  await db
    .delete(recipes)
    .where(and(eq(recipes.organizationId, organizationId), eq(recipes.id, id)));
}
