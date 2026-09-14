import type { Dimension } from '@/lib/units';

/**
 * Recipe cost — the heart of the product (CLAUDE.md). Pure function, no I/O.
 *
 * Costs are ALWAYS computed live from current ingredient prices, so a recipe's
 * cost is never stored or cached: change an ingredient's price and every recipe
 * using it reflects the new cost the next time it is read (see the Recipes
 * cascade in app/(app)/ingredients/actions.ts revalidation).
 *
 * Money is in integer cents. Quantities are canonical (g / ml / count) and prices
 * are per canonical purchase unit (per kg / litre / piece), so a line costs:
 *   weight  → priceCents × grams / 1000
 *   volume  → priceCents × millilitres / 1000
 *   count   → priceCents × pieces
 */

export type RecipeCostLine = {
  dimension: Dimension;
  /** Price per canonical purchase unit (per kg / litre / piece), in cents. */
  priceCents: number;
  /** Canonical amount used: grams (weight), millilitres (volume), or count. */
  quantity: number;
  /**
   * Optional prep-action usable yield in basis points (10000 = 100%, no loss).
   * The line's `quantity` is the EDIBLE amount the recipe uses; to obtain it you
   * must purchase `quantity / (prepYieldBps/10000)` (Recipes 2.0 §6.6/§7.3), so
   * the loss inflates cost WITHOUT double-counting. Absent/undefined = no prep
   * loss (frozen-fixture lines cost exactly as before). Out-of-range/non-finite
   * values are treated as "no loss" — never a silent zero or a runaway cost.
   */
  prepYieldBps?: number;
};

/** Usable-yield fraction of a prep action, or 1 when there is no valid loss. */
function prepYieldFraction(prepYieldBps: number | undefined): number {
  if (
    prepYieldBps == null ||
    !Number.isFinite(prepYieldBps) ||
    prepYieldBps <= 0 ||
    prepYieldBps >= 10_000
  ) {
    return 1;
  }
  return prepYieldBps / 10_000;
}

export type RecipeCostInput = {
  yieldPortions: number;
  /**
   * Output yield after production loss (100 = no loss). Loss applies ONCE, to what a
   * batch MAKES — finished weight = input weight × yield ÷ 100 — so it never inflates
   * what the batch COSTS here. Kept on the input for callers that pass the recipe row.
   */
  yieldPercentage: number;
  laborCostCents: number;
  energyCostCents: number;
  packagingCostCents: number;
  lines: RecipeCostLine[];
  /**
   * Raw material cost of each sub-recipe component line, in (possibly
   * fractional) cents — from `componentRawCostCents()`. Components are material
   * inputs: they join the direct ingredient lines BEFORE the parent's yield-loss
   * adjustment. Hidden costs stay after loss adjustment, unchanged.
   */
  componentMaterialCostsCents?: number[];
};

export type RecipeCost = {
  /** Ingredient cost of the batch (what goes in), in cents. */
  ingredientCostCents: number;
  /** Labor + energy + packaging, in cents. */
  hiddenCostCents: number;
  /** Total batch cost, in cents. */
  totalCostCents: number;
  /** Total cost divided across the yield, in cents. */
  costPerPortionCents: number;
};

/**
 * Canonical units per priced purchase unit, by dimension. The single source of
 * truth for "price is per kg / litre / piece": both this module and the F2
 * purchase-price conversion (lib/calculations/purchasePrice.ts) import it.
 */
export const CANONICAL_PER_PRICE_UNIT: Record<Dimension, number> = {
  weight: 1000, // grams per kg
  volume: 1000, // millilitres per litre
  count: 1, // pieces per piece
};

export function lineCostCents(line: RecipeCostLine): number {
  const purchased =
    (line.priceCents * line.quantity) / CANONICAL_PER_PRICE_UNIT[line.dimension];
  return purchased / prepYieldFraction(line.prepYieldBps);
}

/**
 * Cost per kilogram of finished batch, in integer cents — the manager-only batch
 * metric (Recipe-editor parity, D2). Pure: no formatting, no I/O.
 *
 *   costPerKgCents = round(totalCostCents * 1000 / yieldWeightGrams)
 *
 * Returns `null` (renders as "—") when it can't be computed honestly: a missing,
 * zero, negative or non-finite yield weight, or a non-finite total cost. A `null`
 * here is the signal to hide the tile, never a "free" 0.
 */
export function costPerKgCents(
  totalCostCents: number,
  yieldWeightGrams: number | null | undefined,
): number | null {
  if (yieldWeightGrams == null || !Number.isFinite(yieldWeightGrams) || yieldWeightGrams <= 0) {
    return null;
  }
  if (!Number.isFinite(totalCostCents)) return null;
  return Math.round((totalCostCents * 1000) / yieldWeightGrams);
}

/**
 * Cost of a target finished weight scaled from the batch, in integer cents — the
 * per-preset cost preview (Recipe-editor parity, D3). Scales the EXACT batch total
 * by the weight factor and rounds ONCE (never re-rounds from cost/kg):
 *
 *   presetCostCents = round(totalCostCents * targetWeightGrams / yieldWeightGrams)
 *
 * Returns `null` when the base/target weight or total cost is missing, zero,
 * negative or non-finite.
 */
export function presetCostCents(
  totalCostCents: number,
  yieldWeightGrams: number | null | undefined,
  targetWeightGrams: number | null | undefined,
): number | null {
  if (yieldWeightGrams == null || !Number.isFinite(yieldWeightGrams) || yieldWeightGrams <= 0) {
    return null;
  }
  if (targetWeightGrams == null || !Number.isFinite(targetWeightGrams) || targetWeightGrams <= 0) {
    return null;
  }
  if (!Number.isFinite(totalCostCents)) return null;
  return Math.round((totalCostCents * targetWeightGrams) / yieldWeightGrams);
}

/**
 * Raw material cost of one sub-recipe component line, in (possibly fractional)
 * cents — a finished-weight slice of the component's EXACT batch total:
 *
 *   componentRawCostCents = subRecipeTotalCostCents × quantityGrams / subRecipeYieldWeightGrams
 *
 * NOT rounded here: like `lineCostCents()`, fractions survive until the single
 * batch-boundary rounding in `recipeCost()`. Returns `null` when it can't be
 * computed honestly (missing/zero/negative/non-finite yield weight or quantity,
 * or a non-finite total) — the resolver turns a `null` into an INCOMPLETE parent
 * cost (`costCents: null`), never a free 0.
 */
export function componentRawCostCents(
  subRecipeTotalCostCents: number,
  quantityGrams: number,
  subRecipeYieldWeightGrams: number | null | undefined,
): number | null {
  if (
    subRecipeYieldWeightGrams == null ||
    !Number.isFinite(subRecipeYieldWeightGrams) ||
    subRecipeYieldWeightGrams <= 0
  ) {
    return null;
  }
  if (!Number.isFinite(quantityGrams) || quantityGrams <= 0) return null;
  if (!Number.isFinite(subRecipeTotalCostCents)) return null;
  return (subRecipeTotalCostCents * quantityGrams) / subRecipeYieldWeightGrams;
}

export function recipeCost(input: RecipeCostInput): RecipeCost {
  const rawIngredientCost =
    input.lines.reduce((sum, line) => sum + lineCostCents(line), 0) +
    (input.componentMaterialCostsCents ?? []).reduce((sum, c) => sum + c, 0);

  // Production loss is applied once, to the finished WEIGHT (see
  // `finishedWeightGrams`) — never by inflating the ingredients' cost as well.
  const ingredientCost = rawIngredientCost;

  const hiddenCostCents =
    input.laborCostCents + input.energyCostCents + input.packagingCostCents;

  const totalFloat = ingredientCost + hiddenCostCents;
  const portions = input.yieldPortions > 0 ? input.yieldPortions : 1;

  return {
    ingredientCostCents: Math.round(ingredientCost),
    hiddenCostCents,
    totalCostCents: Math.round(totalFloat),
    costPerPortionCents: Math.round(totalFloat / portions),
  };
}

/**
 * Finished usable output of a batch, in grams (Recipes yield calculator):
 *
 *   measured weight, when the chef weighed the batch; otherwise
 *   input weight × yield% ÷ 100, where input weight = weight lines (g) + sub-recipe
 *   components (finished g).
 *
 * Volume and count lines never count as grams — with any of them present (and no
 * measured weight) the result is `null`, so the UI asks for a measured weight
 * instead of inventing one.
 */
export function finishedWeightGrams(input: {
  measuredGrams: number | null | undefined;
  yieldPercentage: number;
  lines: { dimension: Dimension; quantity: number }[];
  componentGrams: number[];
}): number | null {
  if (input.measuredGrams != null && Number.isFinite(input.measuredGrams) && input.measuredGrams > 0) {
    return input.measuredGrams;
  }
  const weight = recipeInputWeightGrams(input.lines, input.componentGrams);
  if (weight === null) return null;
  if (!Number.isFinite(input.yieldPercentage) || input.yieldPercentage <= 0) return null;
  const grams = Math.round(((weight * input.yieldPercentage) / 100) * 100) / 100;
  return grams > 0 ? grams : null;
}

/** Ingredient input weight in grams, or null when a volume/count line has no gram value. */
export function recipeInputWeightGrams(
  lines: { dimension: Dimension; quantity: number }[],
  componentGrams: number[],
): number | null {
  let grams = 0;
  for (const line of lines) {
    if (line.dimension !== 'weight') return null;
    if (!Number.isFinite(line.quantity) || line.quantity < 0) return null;
    grams += line.quantity;
  }
  for (const g of componentGrams) {
    if (!Number.isFinite(g) || g < 0) return null;
    grams += g;
  }
  return grams > 0 ? grams : null;
}

/** Yield % that a measured finished weight implies (for the calculator's display). */
export function impliedYieldPercentage(inputGrams: number | null, measuredGrams: number | null): number | null {
  if (inputGrams == null || measuredGrams == null || !(inputGrams > 0) || !(measuredGrams > 0)) return null;
  return Math.round((measuredGrams / inputGrams) * 10_000) / 100;
}
