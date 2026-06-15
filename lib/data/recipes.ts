import { and, count, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { ingredients, recipeIngredients, recipes } from '@/lib/db/schema';
import type { Ingredient, Recipe, NewRecipe } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';

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
    .where(
      and(eq(recipes.organizationId, organizationId), isNull(recipes.deletedAt)),
    )
    .orderBy(recipes.name);
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
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        eq(recipes.id, id),
        // A trashed recipe must be restored before it can be edited.
        isNull(recipes.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
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
 */
export async function purgeRecipe(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<void> {
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
