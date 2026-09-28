import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ingredients, recipeFolders, recipeIngredients, recipes } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { folderPath } from '@/lib/folders/tree';

/**
 * "Where is this ingredient used?" — the recipes that contain an ingredient, either
 * DIRECTLY (a `recipe_ingredients` line) or INDIRECTLY through a sub-recipe component
 * (`recipe_components`, any depth). Reads names + folder paths only — never recipe
 * lines, costs or margins — so it is safe for kitchen viewers too.
 *
 * Everything is keyed by ids and scoped by `organizationId` (RULE #1); trashed recipes
 * are excluded, and a trashed intermediate recipe does not carry usage upward.
 */

/** One recipe that uses the ingredient. Each recipe appears exactly once. */
export type IngredientRecipeUsage = {
  id: string;
  name: string;
  /** Folder breadcrumb, root → leaf, e.g. `['Pastry', 'Fillings']`. Empty = no folder. */
  folderPath: string[];
  /**
   * Names of the sub-recipes this recipe reaches the ingredient THROUGH (its immediate
   * components on the path), A→Z. Empty when the ingredient is entered directly on the
   * recipe — a recipe that has it both ways counts as direct.
   */
  via: string[];
};

export type IngredientRecipeUsageResult = {
  /** Unique accessible recipes — always equals `recipes.length`. */
  count: number;
  recipes: IngredientRecipeUsage[];
};

function rowsOf<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  const rows = (res as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/**
 * Active recipes using `ingredientId`, direct first-class and via nested components.
 * Returns `null` when the ingredient is not an active ingredient of this org (so the
 * caller can tell "not found" apart from "not used").
 *
 * The upward walk is a recursive CTE over `(parent, component)` EDGES with plain
 * `UNION`: the edge set is finite, so it terminates even on corrupt/cyclic data, with
 * no depth counter needed. Each hop requires the parent to be active.
 */
export async function loadIngredientRecipeUsage(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
): Promise<IngredientRecipeUsageResult | null> {
  const [ingredient] = await db
    .select({ id: ingredients.id })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, ingredientId),
        isNull(ingredients.deletedAt),
      ),
    )
    .limit(1);
  if (!ingredient) return null;

  const directRows = await db
    .selectDistinct({ id: recipes.id })
    .from(recipeIngredients)
    .innerJoin(
      recipes,
      and(
        eq(recipes.organizationId, recipeIngredients.organizationId),
        eq(recipes.id, recipeIngredients.recipeId),
      ),
    )
    .where(
      and(
        eq(recipeIngredients.organizationId, organizationId),
        eq(recipeIngredients.ingredientId, ingredientId),
        isNull(recipes.deletedAt),
      ),
    );
  const directIds = new Set(directRows.map((r) => r.id));

  // Edges (parent → component) on every upward path from the direct recipes.
  const indirectEdges =
    directIds.size === 0
      ? []
      : rowsOf<{ parent_id: string; component_id: string }>(
          await db.execute(sql`
            WITH RECURSIVE up(parent_id, component_id) AS (
              SELECT rc.recipe_id, rc.component_recipe_id
                FROM recipe_components rc
                JOIN recipes p
                  ON p.organization_id = rc.organization_id
                 AND p.id = rc.recipe_id
                 AND p.deleted_at IS NULL
               WHERE rc.organization_id = ${organizationId}
                 AND rc.component_recipe_id IN (${sql.join(
                   [...directIds].map((id) => sql`${id}`),
                   sql`, `,
                 )})
              UNION
              SELECT rc.recipe_id, rc.component_recipe_id
                FROM recipe_components rc
                JOIN up ON rc.component_recipe_id = up.parent_id
                JOIN recipes p
                  ON p.organization_id = rc.organization_id
                 AND p.id = rc.recipe_id
                 AND p.deleted_at IS NULL
               WHERE rc.organization_id = ${organizationId}
            )
            SELECT parent_id, component_id FROM up
          `),
        );

  const viaIdsByRecipe = new Map<string, Set<string>>();
  for (const edge of indirectEdges) {
    const set = viaIdsByRecipe.get(edge.parent_id) ?? new Set<string>();
    set.add(edge.component_id);
    viaIdsByRecipe.set(edge.parent_id, set);
  }

  const allIds = new Set<string>([...directIds, ...viaIdsByRecipe.keys()]);
  if (allIds.size === 0) return { count: 0, recipes: [] };

  const [recipeRows, folders] = await Promise.all([
    db
      .select({ id: recipes.id, name: recipes.name, folderId: recipes.folderId })
      .from(recipes)
      .where(
        and(
          eq(recipes.organizationId, organizationId),
          inArray(recipes.id, [...allIds]),
          isNull(recipes.deletedAt),
        ),
      ),
    db
      .select({
        id: recipeFolders.id,
        name: recipeFolders.name,
        parentId: recipeFolders.parentId,
      })
      .from(recipeFolders)
      .where(eq(recipeFolders.organizationId, organizationId)),
  ]);

  // Every via component is itself on the path (a direct recipe, or an active parent
  // reached by an earlier hop), so its name is already in `recipeRows`.
  const nameById = new Map(recipeRows.map((r) => [r.id, r.name]));

  const result: IngredientRecipeUsage[] = recipeRows.map((r) => ({
    id: r.id,
    name: r.name,
    folderPath: r.folderId ? folderPath(folders, r.folderId).map((f) => f.name) : [],
    via: directIds.has(r.id)
      ? []
      : [...(viaIdsByRecipe.get(r.id) ?? [])]
          .map((id) => nameById.get(id))
          .filter((n): n is string => n !== undefined)
          .sort((a, b) => a.localeCompare(b)),
  }));
  result.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { count: result.length, recipes: result };
}
