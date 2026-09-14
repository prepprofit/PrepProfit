import type { Dimension } from '@/lib/units';
import { CANONICAL_PER_PRICE_UNIT } from '@/lib/calculations/recipeCost';
import { lineTax, MAX_TAX_RATE_BPS } from '@/lib/calculations/tax';

/**
 * Dish Builder maths — pure, no I/O. A dish (stored in `menus`) is what a customer
 * buys: recipe lines (by portion, g or kg) plus direct ingredient lines (fruit,
 * garnish, boxes…), making `portions` sellable portions. Money is integer cents in
 * and out; fractions survive internally and are rounded ONCE at the boundary.
 *
 * Cost is complete-or-null (D5): one unpriced ingredient, trashed
 * recipe or unconvertible gram line makes the WHOLE dish cost null — never a
 * flattering partial sum.
 *
 * Every consumer of dish cost — the builder, Menu Engineering, the CFO report,
 * profit leaks, cost impact — goes through `dishCost`, so they cannot disagree.
 *
 * Extension point: `adjustments` carries per-dish costs beyond components (labour,
 * energy, packaging, delivery, waste allowance). None are stored yet; adding one is
 * a new `DishCostAdjustmentKind` + a column, with no change to consumers.
 */

// ── Units ─────────────────────────────────────────────────────────────────────

export const DISH_RECIPE_UNITS = ['portion', 'g', 'kg'] as const;
export type DishRecipeUnit = (typeof DISH_RECIPE_UNITS)[number];

export const DISH_INGREDIENT_UNITS = ['g', 'kg', 'ml', 'l', 'piece'] as const;
export type DishIngredientUnit = (typeof DISH_INGREDIENT_UNITS)[number];

const INGREDIENT_UNIT_DIMENSION: Record<DishIngredientUnit, Dimension> = {
  g: 'weight',
  kg: 'weight',
  ml: 'volume',
  l: 'volume',
  piece: 'count',
};
const INGREDIENT_UNIT_FACTOR: Record<DishIngredientUnit, number> = {
  g: 1,
  kg: 1000,
  ml: 1,
  l: 1000,
  piece: 1,
};

/** Units an ingredient of `dimension` may be entered in. */
export function ingredientUnitsFor(dimension: Dimension): DishIngredientUnit[] {
  return DISH_INGREDIENT_UNITS.filter((u) => INGREDIENT_UNIT_DIMENSION[u] === dimension);
}

export function isIngredientUnitFor(unit: DishIngredientUnit, dimension: Dimension): boolean {
  return INGREDIENT_UNIT_DIMENSION[unit] === dimension;
}

/** Entered amount → canonical g / ml / count. */
export function ingredientCanonicalQuantity(amount: number, unit: DishIngredientUnit): number {
  return amount * INGREDIENT_UNIT_FACTOR[unit];
}

/** Canonical quantity → amount in the display unit. */
export function ingredientDisplayAmount(canonical: number, unit: DishIngredientUnit): number {
  return canonical / INGREDIENT_UNIT_FACTOR[unit];
}

export type RecipeYield = {
  yieldPortions: number;
  /** Usable finished batch weight in grams; null = not set. */
  yieldWeightGrams: number | null;
};

/**
 * How many recipe PORTIONS a recipe line represents. Portion lines are 1:1; gram
 * lines need the recipe's finished batch weight (grams ÷ batch weight × batch
 * portions). Null when that can't be computed honestly.
 */
export function recipePortionEquivalent(
  amount: number,
  unit: DishRecipeUnit,
  recipe: RecipeYield,
): number | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (unit === 'portion') return amount;
  const grams = unit === 'kg' ? amount * 1000 : amount;
  const weight = recipe.yieldWeightGrams;
  if (weight == null || !Number.isFinite(weight) || weight <= 0) return null;
  if (!Number.isFinite(recipe.yieldPortions) || recipe.yieldPortions <= 0) return null;
  return (grams / weight) * recipe.yieldPortions;
}

// ── Cost ─────────────────────────────────────────────────────────────────────

export type DishRecipeLineCostInput = {
  key: string;
  /** The recipe's current cost per portion, cents; null = unavailable/unpriced. */
  costPerPortionCents: number | null;
  /** From {@link recipePortionEquivalent}; null = unconvertible. */
  portionEquivalent: number | null;
};

export type DishIngredientLineCostInput = {
  key: string;
  dimension: Dimension;
  /** Current price per kg / litre / piece, cents; null = unpriced or unavailable. */
  priceCents: number | null;
  /** Canonical quantity for the whole dish (g / ml / count). */
  quantity: number;
};

export const DISH_COST_ADJUSTMENT_KINDS = [
  'labour',
  'energy',
  'packaging',
  'delivery',
  'waste',
] as const;
export type DishCostAdjustmentKind = (typeof DISH_COST_ADJUSTMENT_KINDS)[number];

/** A whole-dish cost beyond its components (future: labour, energy, waste…). */
export type DishCostAdjustment = { kind: DishCostAdjustmentKind; cents: number };

export type DishCostInput = {
  portions: number;
  recipeLines: DishRecipeLineCostInput[];
  ingredientLines: DishIngredientLineCostInput[];
  adjustments?: DishCostAdjustment[];
};

export type DishLineCost = { key: string; costCents: number | null };

export type DishCost = {
  complete: boolean;
  /** Whole-dish cost (all portions), cents; null when incomplete. */
  totalCostCents: number | null;
  costPerPortionCents: number | null;
  /** Rounded contribution per line for display (null = that line is the gap). */
  lineCosts: DishLineCost[];
  /** Keys of the lines that made the dish incomplete. */
  incompleteKeys: string[];
};

function recipeLineCost(line: DishRecipeLineCostInput): number | null {
  const { costPerPortionCents: cost, portionEquivalent: eq } = line;
  if (cost == null || !Number.isFinite(cost) || cost < 0) return null;
  if (eq == null || !Number.isFinite(eq) || eq <= 0) return null;
  return cost * eq;
}

function ingredientLineCost(line: DishIngredientLineCostInput): number | null {
  if (line.priceCents == null || !Number.isFinite(line.priceCents) || line.priceCents < 0) {
    return null;
  }
  if (!Number.isFinite(line.quantity) || line.quantity <= 0) return null;
  return (line.priceCents * line.quantity) / CANONICAL_PER_PRICE_UNIT[line.dimension];
}

export function dishCost(input: DishCostInput): DishCost {
  const lineCosts: DishLineCost[] = [];
  const incompleteKeys: string[] = [];
  let total = 0;

  for (const line of input.recipeLines) {
    const cost = recipeLineCost(line);
    lineCosts.push({ key: line.key, costCents: cost === null ? null : Math.round(cost) });
    if (cost === null) incompleteKeys.push(line.key);
    else total += cost;
  }
  for (const line of input.ingredientLines) {
    const cost = ingredientLineCost(line);
    lineCosts.push({ key: line.key, costCents: cost === null ? null : Math.round(cost) });
    if (cost === null) incompleteKeys.push(line.key);
    else total += cost;
  }
  let adjustmentsValid = true;
  for (const adj of input.adjustments ?? []) {
    if (!Number.isFinite(adj.cents) || adj.cents < 0) adjustmentsValid = false;
    else total += adj.cents;
  }

  const portions = input.portions;
  const hasLines = input.recipeLines.length + input.ingredientLines.length > 0;
  const complete =
    hasLines &&
    incompleteKeys.length === 0 &&
    adjustmentsValid &&
    Number.isFinite(total) &&
    Number.isInteger(portions) &&
    portions >= 1 &&
    Number.isSafeInteger(Math.round(total));

  return {
    complete,
    totalCostCents: complete ? Math.round(total) : null,
    costPerPortionCents: complete ? Math.round(total / portions) : null,
    lineCosts,
    incompleteKeys,
  };
}

// ── Pricing (bidirectional) ──────────────────────────────────────────────────

const BPS = 10_000;

function clampVat(bps: number): number {
  if (!Number.isFinite(bps)) return 0;
  return Math.min(MAX_TAX_RATE_BPS, Math.max(0, Math.round(bps)));
}

/** Net (excl. VAT) → gross, using the same half-up rounding as sales tax. */
export function priceInclVat(priceExclCents: number, vatBps: number): number {
  return priceExclCents + lineTax(priceExclCents, clampVat(vatBps));
}

/** Gross (incl. VAT) → net. */
export function priceExclVat(priceInclCents: number, vatBps: number): number {
  return Math.round(priceInclCents / (1 + clampVat(vatBps) / BPS));
}

/**
 * Net price that yields `marginBps` gross margin on `costCents`:
 * price = cost ÷ (1 − margin). Null when the cost is unknown/zero or the margin is
 * outside 0 ≤ m < 100%.
 */
export function priceForMargin(costCents: number | null, marginBps: number): number | null {
  if (costCents == null || !Number.isFinite(costCents) || costCents <= 0) return null;
  if (!Number.isFinite(marginBps) || marginBps < 0 || marginBps >= BPS) return null;
  return Math.round(costCents / (1 - marginBps / BPS));
}

/** Net price at which cost is `foodCostBps` of it: price = cost ÷ food cost. */
export function priceForFoodCost(costCents: number | null, foodCostBps: number): number | null {
  if (costCents == null || !Number.isFinite(costCents) || costCents <= 0) return null;
  if (!Number.isFinite(foodCostBps) || foodCostBps <= 0 || foodCostBps > BPS) return null;
  return Math.round(costCents / (foodCostBps / BPS));
}

export type DishPricing = {
  priceExclCents: number | null;
  priceInclCents: number | null;
  /** Per portion; null without a positive price or a complete cost. */
  grossProfitCents: number | null;
  marginBps: number | null;
  foodCostBps: number | null;
};

/** KPIs for one portion at a net price. */
export function dishPricing(
  costPerPortionCents: number | null,
  priceExclCents: number | null,
  vatBps: number,
): DishPricing {
  const price =
    priceExclCents != null && Number.isFinite(priceExclCents) && priceExclCents >= 0
      ? priceExclCents
      : null;
  const priceIncl = price === null ? null : priceInclVat(price, vatBps);
  if (price === null || price <= 0 || costPerPortionCents == null || !Number.isFinite(costPerPortionCents)) {
    return {
      priceExclCents: price,
      priceInclCents: priceIncl,
      grossProfitCents: null,
      marginBps: null,
      foodCostBps: null,
    };
  }
  return {
    priceExclCents: price,
    priceInclCents: priceIncl,
    grossProfitCents: price - costPerPortionCents,
    marginBps: Math.round(((price - costPerPortionCents) / price) * BPS),
    foodCostBps: Math.round((costPerPortionCents / price) * BPS),
  };
}

// ── Composition → cost (shared by every consumer) ────────────────────────────

/** A dish's stored composition, as the catalogue and the data layer load it. */
export type DishComposition = {
  portions: number;
  recipeLines: { recipeId: string; quantity: number; unit: DishRecipeUnit }[];
  /** `quantity` is canonical (g / ml / count) for the whole dish. */
  ingredientLines: { ingredientId: string; quantity: number; unit: DishIngredientUnit }[];
};

export type DishIngredientPrice = {
  dimension: Dimension;
  priceCents: number;
  /** An ingredient still needing a price costs as UNKNOWN, never as its stale/0 price. */
  needsPricing: boolean;
};

export type DishCostLookups = {
  /** Current cost per portion of an active recipe; null = unavailable/unpriced. */
  recipeCostPerPortion: (recipeId: string) => number | null;
  recipeYield: (recipeId: string) => RecipeYield | null;
  /** Null = the ingredient is trashed/missing. */
  ingredient: (ingredientId: string) => DishIngredientPrice | null;
};

export const recipeLineKey = (recipeId: string) => `r:${recipeId}`;
export const ingredientLineKey = (ingredientId: string) => `i:${ingredientId}`;

/** Cost a stored composition with the caller's price lens (current or projected). */
export function compositionCost(dish: DishComposition, lookups: DishCostLookups): DishCost {
  return dishCost({
    portions: dish.portions,
    recipeLines: dish.recipeLines.map((line) => {
      const yieldInfo = lookups.recipeYield(line.recipeId);
      return {
        key: recipeLineKey(line.recipeId),
        costPerPortionCents: lookups.recipeCostPerPortion(line.recipeId),
        portionEquivalent: yieldInfo
          ? recipePortionEquivalent(line.quantity, line.unit, yieldInfo)
          : null,
      };
    }),
    ingredientLines: dish.ingredientLines.map((line) => {
      const ing = lookups.ingredient(line.ingredientId);
      return {
        key: ingredientLineKey(line.ingredientId),
        dimension: ing?.dimension ?? 'count',
        priceCents: ing && !ing.needsPricing ? ing.priceCents : null,
        quantity: line.quantity,
      };
    }),
  });
}
