import type { Dimension } from '@/lib/units';
import { CANONICAL_PER_PRICE_UNIT } from '@/lib/calculations/recipeCost';
import { lineTax, MAX_TAX_RATE_BPS } from '@/lib/calculations/tax';

/**
 * Menu product maths — pure, no I/O. A product (stored in `menus`) is one BATCH:
 * recipe lines (by portion, g or kg) + direct ingredient lines (fruit, garnish,
 * boxes…) that make a stated output ("This batch makes 20 kg" / "50 cakes"), plus
 * optional production labour, extra work and expenses.
 *
 * Money is integer cents in and out; fractions survive internally (`exactTotalCents`)
 * and every displayed figure is rounded ONCE from the exact value — never a batch
 * total rebuilt from an already-rounded per-unit cost.
 *
 * Cost is complete-or-null: an unpriced ingredient, a trashed recipe, an
 * unconvertible gram line or invalid labour makes the cost unknown — never a
 * flattering partial sum.
 *
 * Labour (no double counting): when the product has its own production labour, it
 * is the COMPLETE labour estimate, so recipe labour (incl. nested sub-recipes) is
 * excluded from component costs; energy and packaging stay. When labour is not
 * entered, recipe costs are used exactly as before.
 *
 * Every consumer — the builder, Menu lists, sales, Menu Engineering, CFO report,
 * daily close, profit leaks, cost impact, prep planner — goes through
 * `compositionCost`, so they cannot disagree.
 */

// ── Batch output ─────────────────────────────────────────────────────────────

export const DISH_OUTPUT_UNITS = ['g', 'kg', 'piece', 'cake', 'portion'] as const;
export type DishOutputUnit = (typeof DISH_OUTPUT_UNITS)[number];
export type DishOutputKind = 'weight' | 'count';

/** What a selling price is per: a kilogram, or one output unit (piece/cake/portion). */
export const PRICE_BASES = ['kg', 'unit'] as const;
export type PriceBasis = (typeof PRICE_BASES)[number];

export function outputKind(unit: DishOutputUnit): DishOutputKind {
  return unit === 'g' || unit === 'kg' ? 'weight' : 'count';
}

export function priceBasisFor(unit: DishOutputUnit): PriceBasis {
  return outputKind(unit) === 'weight' ? 'kg' : 'unit';
}

/** Entered amount → canonical (grams for weight, count for count units). */
export function outputCanonicalQuantity(amount: number, unit: DishOutputUnit): number {
  return unit === 'kg' ? amount * 1000 : amount;
}

/** Canonical → amount in the display unit (20000 g shown in kg → 20). */
export function outputDisplayAmount(canonical: number, unit: DishOutputUnit): number {
  return unit === 'kg' ? canonical / 1000 : canonical;
}

export type DishOutput = {
  /** Canonical: grams (weight units) or a count (piece/cake/portion). */
  quantity: number;
  unit: DishOutputUnit;
  /** Optional finished weight of a COUNT batch, grams. Never inferred. */
  finishedWeightGrams: number | null;
};

const positiveFinite = (n: number | null | undefined): n is number =>
  n != null && Number.isFinite(n) && n > 0;

const nonNegativeFinite = (n: number) => Number.isFinite(n) && n >= 0;

/** How many price-basis units the batch makes: kg for weight, units for count. */
export function outputSaleUnits(output: DishOutput): number | null {
  if (!positiveFinite(output.quantity)) return null;
  return outputKind(output.unit) === 'weight' ? output.quantity / 1000 : output.quantity;
}

/** Finished batch weight in kg, when known (weight batches always; count batches if entered). */
export function outputWeightKg(output: DishOutput): number | null {
  if (outputKind(output.unit) === 'weight') {
    return positiveFinite(output.quantity) ? output.quantity / 1000 : null;
  }
  return positiveFinite(output.finishedWeightGrams) ? output.finishedWeightGrams / 1000 : null;
}

// ── Component units ──────────────────────────────────────────────────────────

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
const INGREDIENT_UNIT_FACTOR: Record<DishIngredientUnit, number> = { g: 1, kg: 1000, ml: 1, l: 1000, piece: 1 };

export function ingredientUnitsFor(dimension: Dimension): DishIngredientUnit[] {
  return DISH_INGREDIENT_UNITS.filter((u) => INGREDIENT_UNIT_DIMENSION[u] === dimension);
}

export function isIngredientUnitFor(unit: DishIngredientUnit, dimension: Dimension): boolean {
  return INGREDIENT_UNIT_DIMENSION[unit] === dimension;
}

export function ingredientCanonicalQuantity(amount: number, unit: DishIngredientUnit): number {
  return amount * INGREDIENT_UNIT_FACTOR[unit];
}

export function ingredientDisplayAmount(canonical: number, unit: DishIngredientUnit): number {
  return canonical / INGREDIENT_UNIT_FACTOR[unit];
}

export type RecipeYield = { yieldPortions: number; yieldWeightGrams: number | null };

/** Recipe PORTIONS a recipe line represents (g/kg need the recipe's batch weight). */
export function recipePortionEquivalent(
  amount: number,
  unit: DishRecipeUnit,
  recipe: RecipeYield,
): number | null {
  if (!positiveFinite(amount)) return null;
  if (unit === 'portion') return amount;
  const grams = unit === 'kg' ? amount * 1000 : amount;
  if (!positiveFinite(recipe.yieldWeightGrams) || !positiveFinite(recipe.yieldPortions)) return null;
  return (grams / recipe.yieldWeightGrams) * recipe.yieldPortions;
}

// ── Labour & extras ──────────────────────────────────────────────────────────

/** Production labour for the whole batch; null = not entered (recipe labour applies). */
export type DishLabour = { hours: number; hourlyCents: number } | null;

export type DishExtra =
  | { kind: 'work'; hours: number; hourlyCents: number }
  | { kind: 'expense'; amountCents: number };

/**
 * Hours are stored with 2 decimals. Round once, correcting binary float error
 * (1.255 × 100 = 125.49999… would otherwise round down).
 */
export function roundHours(hours: number): number {
  return Math.round(Number((hours * 100).toPrecision(12))) / 100;
}

function workCents(hours: number, hourlyCents: number): number | null {
  return nonNegativeFinite(hours) && nonNegativeFinite(hourlyCents) ? hours * hourlyCents : null;
}

// ── Cost ─────────────────────────────────────────────────────────────────────

export type DishComposition = {
  output: DishOutput;
  labour: DishLabour;
  extras: DishExtra[];
  recipeLines: { recipeId: string; quantity: number; unit: DishRecipeUnit }[];
  /** `quantity` is canonical (g / ml / count) for the whole batch. */
  ingredientLines: { ingredientId: string; quantity: number; unit: DishIngredientUnit }[];
};

export type DishIngredientPrice = {
  dimension: Dimension;
  priceCents: number;
  /** An ingredient still needing a price costs as UNKNOWN, never as its stale/0 price. */
  needsPricing: boolean;
};

export type DishCostLookups = {
  /**
   * Current cost per portion of an active recipe; null = unavailable/unpriced.
   * `excludeLabour` drops the recipe's own and nested sub-recipe labour.
   */
  recipeCostPerPortion: (recipeId: string, options: { excludeLabour: boolean }) => number | null;
  recipeYield: (recipeId: string) => RecipeYield | null;
  ingredient: (ingredientId: string) => DishIngredientPrice | null;
};

export const recipeLineKey = (recipeId: string) => `r:${recipeId}`;
export const ingredientLineKey = (ingredientId: string) => `i:${ingredientId}`;
export const LABOUR_KEY = 'labour';
export const extraKey = (index: number) => `extra:${index}`;

export type DishLineCost = { key: string; costCents: number | null };

export type DishCost = {
  complete: boolean;
  /** 'menu' = the product's own labour replaces recipe labour. */
  labourMode: 'menu' | 'inherited';
  /** Blank labour AND at least one recipe cost carries recipe labour. */
  inheritsRecipeLabour: boolean;
  /** Recipes + ingredients + packaging; null while any component is unknown. */
  componentsCents: number | null;
  /** Null when labour is not entered or can't be calculated. */
  productionLabourCents: number | null;
  extraWorkCents: number | null;
  expensesCents: number | null;
  totalCostCents: number | null;
  /** Unrounded total — the base for every derived figure. */
  exactTotalCents: number | null;
  /** kg (weight) or output units (count). */
  saleUnits: number | null;
  costPerSaleUnitCents: number | null;
  /** Weight batches always; count batches only with a finished weight. */
  costPerKgCents: number | null;
  lineCosts: DishLineCost[];
  incompleteKeys: string[];
};

export function compositionCost(dish: DishComposition, lookups: DishCostLookups): DishCost {
  const labourMode = dish.labour === null ? 'inherited' : 'menu';
  const excludeLabour = labourMode === 'menu';
  const lineCosts: DishLineCost[] = [];
  const incompleteKeys: string[] = [];
  let components = 0;
  let componentsKnown = true;
  let inheritsRecipeLabour = false;

  for (const line of dish.recipeLines) {
    const key = recipeLineKey(line.recipeId);
    const yieldInfo = lookups.recipeYield(line.recipeId);
    const eq = yieldInfo ? recipePortionEquivalent(line.quantity, line.unit, yieldInfo) : null;
    const perPortion = lookups.recipeCostPerPortion(line.recipeId, { excludeLabour });
    if (!excludeLabour && perPortion !== null) {
      const withoutLabour = lookups.recipeCostPerPortion(line.recipeId, { excludeLabour: true });
      if (withoutLabour !== null && withoutLabour !== perPortion) inheritsRecipeLabour = true;
    }
    const cost =
      eq !== null && perPortion !== null && nonNegativeFinite(perPortion) ? perPortion * eq : null;
    lineCosts.push({ key, costCents: cost === null ? null : Math.round(cost) });
    if (cost === null) {
      componentsKnown = false;
      incompleteKeys.push(key);
    } else components += cost;
  }

  for (const line of dish.ingredientLines) {
    const key = ingredientLineKey(line.ingredientId);
    const ing = lookups.ingredient(line.ingredientId);
    const cost =
      ing && !ing.needsPricing && nonNegativeFinite(ing.priceCents) && positiveFinite(line.quantity)
        ? (ing.priceCents * line.quantity) / CANONICAL_PER_PRICE_UNIT[ing.dimension]
        : null;
    lineCosts.push({ key, costCents: cost === null ? null : Math.round(cost) });
    if (cost === null) {
      componentsKnown = false;
      incompleteKeys.push(key);
    } else components += cost;
  }

  let labour: number | null = null;
  if (dish.labour !== null) {
    labour = workCents(dish.labour.hours, dish.labour.hourlyCents);
    if (labour === null) incompleteKeys.push(LABOUR_KEY);
  }

  let extraWork = 0;
  let expenses = 0;
  let extrasValid = true;
  dish.extras.forEach((extra, index) => {
    const cents =
      extra.kind === 'work'
        ? workCents(extra.hours, extra.hourlyCents)
        : nonNegativeFinite(extra.amountCents)
          ? extra.amountCents
          : null;
    if (cents === null) {
      extrasValid = false;
      incompleteKeys.push(extraKey(index));
    } else if (extra.kind === 'work') extraWork += cents;
    else expenses += cents;
  });

  const saleUnits = outputSaleUnits(dish.output);
  const hasComponents = dish.recipeLines.length + dish.ingredientLines.length > 0;
  const labourValid = dish.labour === null || labour !== null;
  const total = components + (labour ?? 0) + extraWork + expenses;
  const complete =
    hasComponents &&
    componentsKnown &&
    labourValid &&
    extrasValid &&
    saleUnits !== null &&
    Number.isFinite(total) &&
    Number.isSafeInteger(Math.round(total));

  const weightKg = outputWeightKg(dish.output);
  return {
    complete,
    labourMode,
    inheritsRecipeLabour,
    componentsCents: hasComponents && componentsKnown ? Math.round(components) : null,
    productionLabourCents: labour === null ? null : Math.round(labour),
    extraWorkCents: extrasValid ? Math.round(extraWork) : null,
    expensesCents: extrasValid ? Math.round(expenses) : null,
    totalCostCents: complete ? Math.round(total) : null,
    exactTotalCents: complete ? total : null,
    saleUnits,
    costPerSaleUnitCents: complete && saleUnits ? Math.round(total / saleUnits) : null,
    costPerKgCents: complete && weightKg ? Math.round(total / weightKg) : null,
    lineCosts,
    incompleteKeys,
  };
}

// ── Pricing ──────────────────────────────────────────────────────────────────

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
 * Net price per sale unit that leaves `marginBps` of sales after costs:
 * price = cost ÷ (1 − margin). Pass the EXACT cost per sale unit.
 */
export function priceForMargin(costPerSaleUnitCents: number | null, marginBps: number): number | null {
  if (!positiveFinite(costPerSaleUnitCents)) return null;
  if (!Number.isFinite(marginBps) || marginBps < 0 || marginBps >= BPS) return null;
  return Math.round(costPerSaleUnitCents / (1 - marginBps / BPS));
}

/** Net price per sale unit at which total cost is `shareBps` of sales. */
export function priceForTotalCostShare(costPerSaleUnitCents: number | null, shareBps: number): number | null {
  if (!positiveFinite(costPerSaleUnitCents)) return null;
  if (!Number.isFinite(shareBps) || shareBps <= 0 || shareBps > BPS) return null;
  return Math.round(costPerSaleUnitCents / (shareBps / BPS));
}

export type DishPricing = {
  priceExclCents: number | null;
  priceInclCents: number | null;
  /** Price × whole batch — assumes everything sells. */
  estimatedSalesCents: number | null;
  /** Estimated sales − total batch cost: left for overheads and profit (not net profit). */
  amountLeftCents: number | null;
  /** amountLeft ÷ sales. */
  marginBps: number | null;
  /** Total cost ÷ sales ("Total cost %" — includes labour/packaging, so not food cost). */
  totalCostBps: number | null;
};

export function dishPricing(
  cost: Pick<DishCost, 'exactTotalCents' | 'saleUnits'>,
  priceExclCents: number | null,
  vatBps: number,
): DishPricing {
  const price = priceExclCents != null && nonNegativeFinite(priceExclCents) ? priceExclCents : null;
  const priceIncl = price === null ? null : priceInclVat(price, vatBps);
  const sales = price !== null && cost.saleUnits !== null ? price * cost.saleUnits : null;
  if (sales === null || sales <= 0 || cost.exactTotalCents === null) {
    return {
      priceExclCents: price,
      priceInclCents: priceIncl,
      estimatedSalesCents: sales === null ? null : Math.round(sales),
      amountLeftCents: null,
      marginBps: null,
      totalCostBps: null,
    };
  }
  const left = sales - cost.exactTotalCents;
  return {
    priceExclCents: price,
    priceInclCents: priceIncl,
    estimatedSalesCents: Math.round(sales),
    amountLeftCents: Math.round(left),
    marginBps: Math.round((left / sales) * BPS),
    totalCostBps: Math.round((cost.exactTotalCents / sales) * BPS),
  };
}

// ── Scaling production (distinct from correcting the yield) ─────────────────

/**
 * "Make a different quantity": scale every recipe and direct-ingredient quantity,
 * the output and a known finished weight by `newOutputQuantity / current`. Labour,
 * extra work and expenses are deliberately NOT scaled — the chef reviews them.
 * Correcting the yield is simply editing `output.quantity` without calling this.
 */
export function scaleComposition<T extends DishComposition>(dish: T, newOutputQuantity: number): T | null {
  if (!positiveFinite(dish.output.quantity) || !positiveFinite(newOutputQuantity)) return null;
  const factor = newOutputQuantity / dish.output.quantity;
  return {
    ...dish,
    output: {
      ...dish.output,
      quantity: newOutputQuantity,
      finishedWeightGrams:
        dish.output.finishedWeightGrams === null ? null : dish.output.finishedWeightGrams * factor,
    },
    recipeLines: dish.recipeLines.map((l) => ({ ...l, quantity: l.quantity * factor })),
    ingredientLines: dish.ingredientLines.map((l) => ({ ...l, quantity: l.quantity * factor })),
  };
}
