import type { Dimension } from '@/lib/units';
import { recipeCost } from './recipeCost';
import { menuCost } from './menu';
import { marginPercent, suggestedPriceCents, MARGIN_THRESHOLDS } from './margin';

/**
 * Invoice-to-Profit Impact — pure projection, no I/O, no AI (Sprint 3).
 *
 * A supplier invoice import records `source='import'` PENDING price observations:
 * it raises `ingredients.pending_price_cents` and NEVER touches the approved
 * `price_cents`. This module answers the manager's next question — "so what?":
 * given the ingredients an invoice touched, which recipes and menus would drop
 * below the target margin IF the pending costs were accepted.
 *
 * This is the "pending-cost impact mode" from plan §8. Two truths are computed
 * side by side from the SAME cost engine the rest of the app uses:
 *   - CURRENT  = the approved `price_cents` (today's financial truth);
 *   - PROJECTED = the approved cost with each changed ingredient's PENDING cost
 *     substituted in (what acceptance would make true).
 * The projected numbers are always labelled pending/projected by the UI — this
 * module never treats a pending observation as approved cost.
 *
 * Honesty rules carried over from the Profit Leak Detector (Sprint 1):
 *   - A recipe still carrying an unpriced ingredient (`needsPricing`) that this
 *     invoice does NOT resolve to a real (> 0) cost has an UNTRUE cost, so its
 *     margin is `null` (never a flattered fake). If the invoice IS what finally
 *     prices that ingredient, the projected cost becomes real and is shown.
 *   - An incomplete menu (a trashed/missing component) stays incomplete: `null`
 *     cost and margin, never a fake 0%.
 *
 * Money is integer cents throughout. Inputs are normalized domain shapes (not DB
 * rows) so the loader maps and this module stays unit-testable.
 */

/** One ingredient's approved + pending pricing state. */
export type CostImpactIngredient = {
  id: string;
  name: string;
  /** Current approved cost per priced unit (per kg / litre / piece), cents. */
  priceCents: number;
  /** Latest observed pending cost per priced unit, or null when none pending. */
  pendingPriceCents: number | null;
  /** True when the approved price is a placeholder (0) and must not be trusted. */
  needsPricing: boolean;
};

/** One active recipe line, carrying the ingredient id so a cost can be substituted. */
export type CostImpactRecipeLine = {
  ingredientId: string;
  dimension: Dimension;
  /** Canonical amount used: grams (weight), millilitres (volume), or count. */
  quantity: number;
};

export type CostImpactRecipe = {
  id: string;
  name: string;
  /** Per-portion selling price in cents, or null when the chef hasn't priced it. */
  sellingPriceCents: number | null;
  yieldPortions: number;
  yieldPercentage: number;
  laborCostCents: number;
  energyCostCents: number;
  packagingCostCents: number;
  lines: CostImpactRecipeLine[];
  /** Price-independent sub-recipe hidden-cost slice (see ActiveCatalogue). */
  componentHiddenCostCents?: number;
  /** True when the sub-recipe tree is unresolvable → cost is untrue → null. */
  costUnresolved?: boolean;
};

export type CostImpactMenu = {
  id: string;
  name: string;
  sellingPriceCents: number | null;
  lines: { recipeId: string; quantity: number }[];
};

export type ProjectPendingCostImpactInput = {
  ingredients: CostImpactIngredient[];
  recipes: CostImpactRecipe[];
  menus: CostImpactMenu[];
  /** Ingredient ids this invoice touched (its `applied` lines' matched ingredients). */
  focusIngredientIds: string[];
  /** Defaults to the existing green threshold (65%). */
  targetMarginPercent?: number;
};

/** A single ingredient cost change revealed by the invoice. */
export type IngredientCostChange = {
  ingredientId: string;
  ingredientName: string;
  /** Approved cost per priced unit today, cents (may be 0 if it was unpriced). */
  currentCostCents: number;
  /** Pending cost per priced unit the invoice observed, cents. */
  projectedCostCents: number;
  /** Percent increase (+) / decrease (−), one decimal; null when it was unpriced. */
  percentChange: number | null;
};

export type AffectedRecipeImpact = {
  recipeId: string;
  recipeName: string;
  sellingPriceCents: number | null;
  currentCostPerPortionCents: number | null;
  projectedCostPerPortionCents: number | null;
  currentMarginPercent: number | null;
  projectedMarginPercent: number | null;
  targetMarginPercent: number;
  /** Projected margin is below target (only meaningful when computable). */
  belowTarget: boolean;
  /** Was at/above target (or unpriced) and the pending cost pushes it below. */
  crossesBelowTarget: boolean;
  /** Price that would restore the target margin from the projected cost, cents. */
  suggestedPriceCents: number | null;
};

export type AffectedMenuImpact = {
  menuId: string;
  menuName: string;
  sellingPriceCents: number | null;
  currentCostCents: number | null;
  projectedCostCents: number | null;
  currentMarginPercent: number | null;
  projectedMarginPercent: number | null;
  targetMarginPercent: number;
  belowTarget: boolean;
  crossesBelowTarget: boolean;
  suggestedPriceCents: number | null;
};

export type ProjectedCostImpact = {
  changes: IngredientCostChange[];
  affectedRecipes: AffectedRecipeImpact[];
  affectedMenus: AffectedMenuImpact[];
  summary: {
    ingredientsChangedCount: number;
    recipesAffectedCount: number;
    menusAffectedCount: number;
    recipesBelowTargetCount: number;
    menusBelowTargetCount: number;
  };
};

/** Per-ingredient pricing view used when costing a recipe in one of the two worlds. */
type PriceView = { priceCents: number; unpriced: boolean };

/**
 * Cost a recipe per portion under a given pricing lens, or null when the cost
 * would be untrue (any line's ingredient is unpriced) or non-finite.
 */
function recipeCostPerPortion(
  recipe: CostImpactRecipe,
  priceOf: (ingredientId: string) => PriceView,
): number | null {
  if (recipe.costUnresolved === true) return null;
  let anyUnpriced = false;
  const lines = recipe.lines.map((line) => {
    const view = priceOf(line.ingredientId);
    if (view.unpriced) anyUnpriced = true;
    return { dimension: line.dimension, priceCents: view.priceCents, quantity: line.quantity };
  });
  if (anyUnpriced) return null;

  const cost = recipeCost({
    yieldPortions: recipe.yieldPortions,
    yieldPercentage: recipe.yieldPercentage,
    laborCostCents: recipe.laborCostCents,
    energyCostCents: recipe.energyCostCents,
    packagingCostCents: recipe.packagingCostCents,
    lines,
    componentMaterialCostsCents: [recipe.componentHiddenCostCents ?? 0],
  });
  return Number.isFinite(cost.costPerPortionCents) ? cost.costPerPortionCents : null;
}

/** Gross margin, or null when price or cost is missing/non-positive. */
function marginOrNull(costCents: number | null, priceCents: number | null): number | null {
  if (costCents == null || priceCents == null || priceCents <= 0) return null;
  if (!Number.isFinite(costCents)) return null;
  return marginPercent(costCents, priceCents);
}

/**
 * Project the margin impact of accepting an invoice's pending cost observations.
 *
 * Only ingredients in `focusIngredientIds` whose pending cost differs from the
 * approved cost count as changes; recipes/menus that reference at least one such
 * change are "affected" and returned with current vs projected margins.
 */
export function projectPendingCostImpact(
  input: ProjectPendingCostImpactInput,
): ProjectedCostImpact {
  const target = input.targetMarginPercent ?? MARGIN_THRESHOLDS.green;

  const ingredientById = new Map<string, CostImpactIngredient>();
  for (const ing of input.ingredients) ingredientById.set(ing.id, ing);

  // The set of real cost changes: a focused ingredient whose pending observation
  // differs from today's approved cost. Everything downstream keys off this.
  const changeById = new Map<string, IngredientCostChange>();
  for (const id of new Set(input.focusIngredientIds)) {
    const ing = ingredientById.get(id);
    if (!ing) continue;
    const pending = ing.pendingPriceCents;
    if (pending == null || pending === ing.priceCents) continue;

    changeById.set(id, {
      ingredientId: ing.id,
      ingredientName: ing.name,
      currentCostCents: ing.priceCents,
      projectedCostCents: pending,
      percentChange:
        ing.priceCents > 0
          ? Math.round(((pending - ing.priceCents) / ing.priceCents) * 1000) / 10
          : null,
    });
  }

  // Current-world lens: approved price; an ingredient flagged needs-pricing is untrue.
  const currentPrice = (id: string): PriceView => {
    const ing = ingredientById.get(id);
    if (!ing) return { priceCents: 0, unpriced: true };
    return { priceCents: ing.priceCents, unpriced: ing.needsPricing };
  };
  // Projected-world lens: substitute each change's pending cost; a pending > 0 also
  // resolves a previously-unpriced ingredient into a real one.
  const projectedPrice = (id: string): PriceView => {
    const change = changeById.get(id);
    if (change) {
      return { priceCents: change.projectedCostCents, unpriced: change.projectedCostCents <= 0 };
    }
    return currentPrice(id);
  };

  // Recipe id → does it reference a changed ingredient? Plus both costed worlds.
  const recipeCurrent = new Map<string, number | null>();
  const recipeProjected = new Map<string, number | null>();
  const affectedRecipeIds = new Set<string>();
  for (const recipe of input.recipes) {
    recipeCurrent.set(recipe.id, recipeCostPerPortion(recipe, currentPrice));
    recipeProjected.set(recipe.id, recipeCostPerPortion(recipe, projectedPrice));
    if (recipe.lines.some((l) => changeById.has(l.ingredientId))) {
      affectedRecipeIds.add(recipe.id);
    }
  }

  const affectedRecipes: AffectedRecipeImpact[] = [];
  for (const recipe of input.recipes) {
    if (!affectedRecipeIds.has(recipe.id)) continue;
    const currentCost = recipeCurrent.get(recipe.id) ?? null;
    const projectedCost = recipeProjected.get(recipe.id) ?? null;
    const currentMargin = marginOrNull(currentCost, recipe.sellingPriceCents);
    const projectedMargin = marginOrNull(projectedCost, recipe.sellingPriceCents);
    const belowTarget = projectedMargin != null && projectedMargin < target;

    affectedRecipes.push({
      recipeId: recipe.id,
      recipeName: recipe.name,
      sellingPriceCents: recipe.sellingPriceCents,
      currentCostPerPortionCents: currentCost,
      projectedCostPerPortionCents: projectedCost,
      currentMarginPercent: currentMargin,
      projectedMarginPercent: projectedMargin,
      targetMarginPercent: target,
      belowTarget,
      crossesBelowTarget:
        belowTarget && (currentMargin == null || currentMargin >= target),
      suggestedPriceCents:
        projectedCost != null ? suggestedPriceCents(projectedCost, target) : null,
    });
  }

  const affectedMenus: AffectedMenuImpact[] = [];
  for (const menu of input.menus) {
    // A menu is affected when any component recipe is affected.
    if (!menu.lines.some((l) => affectedRecipeIds.has(l.recipeId))) continue;

    const current = menuCost(
      menu.lines.map((l) => ({
        recipeId: l.recipeId,
        quantity: l.quantity,
        costPerPortionCents: recipeCurrent.get(l.recipeId) ?? null,
      })),
    );
    const projected = menuCost(
      menu.lines.map((l) => ({
        recipeId: l.recipeId,
        quantity: l.quantity,
        costPerPortionCents: recipeProjected.get(l.recipeId) ?? null,
      })),
    );
    const currentCost = current.complete ? current.costCents : null;
    const projectedCost = projected.complete ? projected.costCents : null;
    const currentMargin = marginOrNull(currentCost, menu.sellingPriceCents);
    const projectedMargin = marginOrNull(projectedCost, menu.sellingPriceCents);
    const belowTarget = projectedMargin != null && projectedMargin < target;

    affectedMenus.push({
      menuId: menu.id,
      menuName: menu.name,
      sellingPriceCents: menu.sellingPriceCents,
      currentCostCents: currentCost,
      projectedCostCents: projectedCost,
      currentMarginPercent: currentMargin,
      projectedMarginPercent: projectedMargin,
      targetMarginPercent: target,
      belowTarget,
      crossesBelowTarget:
        belowTarget && (currentMargin == null || currentMargin >= target),
      suggestedPriceCents:
        projectedCost != null ? suggestedPriceCents(projectedCost, target) : null,
    });
  }

  // Biggest cost jumps first (a newly-priced ingredient — percentChange null — is
  // treated as the most notable and sorts to the top).
  const changes = [...changeById.values()].sort((a, b) => {
    const pa = a.percentChange ?? Number.POSITIVE_INFINITY;
    const pb = b.percentChange ?? Number.POSITIVE_INFINITY;
    return pb - pa;
  });

  // Worst margin risk first: newly-at-risk (crosses) → below target → lowest margin.
  const riskRank = (r: { crossesBelowTarget: boolean; belowTarget: boolean }): number =>
    r.crossesBelowTarget ? 0 : r.belowTarget ? 1 : 2;
  const byRisk = <T extends { crossesBelowTarget: boolean; belowTarget: boolean; projectedMarginPercent: number | null }>(
    a: T,
    b: T,
  ): number => {
    const r = riskRank(a) - riskRank(b);
    if (r !== 0) return r;
    const ma = a.projectedMarginPercent ?? Number.POSITIVE_INFINITY;
    const mb = b.projectedMarginPercent ?? Number.POSITIVE_INFINITY;
    return ma - mb;
  };
  affectedRecipes.sort(byRisk);
  affectedMenus.sort(byRisk);

  return {
    changes,
    affectedRecipes,
    affectedMenus,
    summary: {
      ingredientsChangedCount: changes.length,
      recipesAffectedCount: affectedRecipes.length,
      menusAffectedCount: affectedMenus.length,
      recipesBelowTargetCount: affectedRecipes.filter((r) => r.belowTarget).length,
      menusBelowTargetCount: affectedMenus.filter((m) => m.belowTarget).length,
    },
  };
}
