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
