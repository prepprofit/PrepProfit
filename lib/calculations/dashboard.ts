import { recipeCost, type RecipeCostInput } from './recipeCost';
import { marginPercent } from './margin';

/**
 * Dashboard aggregates — pure function, no I/O. Derives at-a-glance KPIs from the
 * recipes the org already has, using the same cost/margin engine as the recipe
 * editor (recipeCost + marginPercent), so the numbers match what the chef sees
 * per recipe.
 *
 * Only recipes with a selling price contribute to margin / food cost (you cannot
 * compute a margin without a price). Revenue and any time-series live in Sprint 2
 * once the `transactions` table exists — they are NOT faked here.
 */

export type DashboardRecipeInput = {
  id: string;
  name: string;
  /** Selling price per portion in cents, or null when the chef hasn't priced it. */
  sellingPriceCents: number | null;
  cost: RecipeCostInput;
  /** True when the sub-recipe tree is unresolvable → cost untrue → no margin. */
  costUnresolved?: boolean;
};

export type TopRecipe = {
  id: string;
  name: string;
  /** Gross margin on the selling price, as a percentage. */
  marginPercent: number;
};

export type DashboardSummary = {
  /** Total recipes in the workspace. */
  activeRecipes: number;
  /** Recipes that have a selling price — the basis for margin / food cost. */
  pricedRecipes: number;
  /** Average gross margin across priced recipes, or null when none are priced. */
  avgMarginPercent: number | null;
  /** Average food cost (ingredient cost ÷ price) across priced recipes, or null. */
  avgFoodCostPercent: number | null;
  /** Priced recipes sorted by margin (desc), capped at `topN`. */
  topByMargin: TopRecipe[];
};

/** Mean of a list rounded to one decimal, or null for an empty list. */
function avgOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return Math.round((sum / values.length) * 10) / 10;
}

export function dashboardSummary(
  recipes: DashboardRecipeInput[],
  topN = 5,
): DashboardSummary {
  const priced = recipes.filter(
    (r) =>
      r.sellingPriceCents != null &&
      r.sellingPriceCents > 0 &&
      r.costUnresolved !== true,
  );

  const metrics = priced.map((r) => {
    const cost = recipeCost(r.cost);
    const price = r.sellingPriceCents as number;
    const portions = r.cost.yieldPortions > 0 ? r.cost.yieldPortions : 1;
    const ingredientPerPortion = cost.ingredientCostCents / portions;
    return {
      id: r.id,
      name: r.name,
      margin: marginPercent(cost.costPerPortionCents, price),
      // Food cost % = ingredient cost per portion ÷ selling price per portion.
      foodCost: Math.round((ingredientPerPortion / price) * 1000) / 10,
    };
  });

  const topByMargin = [...metrics]
    .sort((a, b) => b.margin - a.margin)
    .slice(0, topN)
    .map(({ id, name, margin }) => ({ id, name, marginPercent: margin }));

  return {
    activeRecipes: recipes.length,
    pricedRecipes: priced.length,
    avgMarginPercent: avgOrNull(metrics.map((m) => m.margin)),
    avgFoodCostPercent: avgOrNull(metrics.map((m) => m.foodCost)),
    topByMargin,
  };
}
