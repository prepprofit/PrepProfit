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
};

export type RecipeCostInput = {
  yieldPortions: number;
  /** Usable yield after trim/loss as a percentage (100 = no loss). */
  yieldPercentage: number;
  laborCostCents: number;
  energyCostCents: number;
  packagingCostCents: number;
  lines: RecipeCostLine[];
};

export type RecipeCost = {
  /** Ingredient cost after the loss adjustment, in cents. */
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
  return (line.priceCents * line.quantity) / CANONICAL_PER_PRICE_UNIT[line.dimension];
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

export function recipeCost(input: RecipeCostInput): RecipeCost {
  const rawIngredientCost = input.lines.reduce(
    (sum, line) => sum + lineCostCents(line),
    0,
  );

  // Trim/loss inflates the ingredient cost needed per usable output. Hidden costs
  // are per batch and are NOT loss-adjusted.
  const yieldFraction = input.yieldPercentage > 0 ? input.yieldPercentage / 100 : 1;
  const ingredientCost = rawIngredientCost / yieldFraction;

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
