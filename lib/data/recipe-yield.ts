import { and, eq, inArray, sql } from 'drizzle-orm';
import { ingredients, recipeComponents, recipeIngredients } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { finishedWeightGrams } from '@/lib/calculations/recipeCost';

/**
 * Finished usable weight for many recipes in two grouped, org-scoped queries — the
 * ONE source every recipe display uses for cost per kg (list, detail, editor):
 *
 *   stored weight (measured, or calculated at the last save), else
 *   input weight × yield% ÷ 100 when every direct line is in grams.
 *
 * Volume / count lines never count as grams: such a recipe without a stored weight
 * has no finished weight (null), and the UI asks for a measured one.
 */
export async function loadRecipeFinishedWeights(
  db: TenantClient,
  organizationId: string,
  rows: { id: string; yieldPercentage: number; yieldWeightGrams: number | null }[],
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  const needed = rows.filter((r) => !(r.yieldWeightGrams != null && r.yieldWeightGrams > 0)).map((r) => r.id);
  for (const r of rows) {
    if (r.yieldWeightGrams != null && r.yieldWeightGrams > 0) result.set(r.id, r.yieldWeightGrams);
  }
  if (needed.length === 0) return result;

  const [lineRows, componentRows] = await Promise.all([
    db
      .select({
        recipeId: recipeIngredients.recipeId,
        weightGrams: sql<string>`coalesce(sum(case when ${ingredients.dimension} = 'weight' then ${recipeIngredients.quantity} else 0 end), 0)`,
        otherLines: sql<string>`count(*) filter (where ${ingredients.dimension} <> 'weight')`,
      })
      .from(recipeIngredients)
      .innerJoin(
        ingredients,
        and(eq(ingredients.organizationId, organizationId), eq(ingredients.id, recipeIngredients.ingredientId)),
      )
      .where(and(eq(recipeIngredients.organizationId, organizationId), inArray(recipeIngredients.recipeId, needed)))
      .groupBy(recipeIngredients.recipeId),
    db
      .select({
        recipeId: recipeComponents.recipeId,
        grams: sql<string>`coalesce(sum(${recipeComponents.quantityGrams}), 0)`,
      })
      .from(recipeComponents)
      .where(and(eq(recipeComponents.organizationId, organizationId), inArray(recipeComponents.recipeId, needed)))
      .groupBy(recipeComponents.recipeId),
  ]);
  const lines = new Map(lineRows.map((r) => [r.recipeId, r]));
  const components = new Map(componentRows.map((r) => [r.recipeId, Number(r.grams)]));

  for (const row of rows) {
    if (result.has(row.id)) continue;
    const l = lines.get(row.id);
    if (l && Number(l.otherLines) > 0) {
      result.set(row.id, null);
      continue;
    }
    result.set(
      row.id,
      finishedWeightGrams({
        measuredGrams: null,
        yieldPercentage: row.yieldPercentage,
        lines: l ? [{ dimension: 'weight', quantity: Number(l.weightGrams) }] : [],
        componentGrams: components.has(row.id) ? [components.get(row.id) as number] : [],
      }),
    );
  }
  return result;
}
