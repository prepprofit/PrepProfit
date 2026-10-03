import type { Dimension } from '@/lib/units';
import { CANONICAL_PER_PRICE_UNIT } from '@/lib/calculations/recipeCost';
import { lineTax, MAX_TAX_RATE_BPS } from '@/lib/calculations/tax';

/**
 * Menu product maths — pure, no I/O. A product (stored in `menus`) is one BATCH:
 * recipe lines (by g, or portions saved earlier) + direct ingredient lines (fruit,
 * garnish, boxes…) that make a stated output ("These quantities make 300 mini
 * cakes"), plus optional production labour, extra work and expenses.
 *
 * Money is integer cents in and out; fractions survive internally (`exact…`) and
 * every displayed figure is rounded ONCE from the exact value — never a batch total
 * rebuilt from an already-rounded per-unit cost.
 *
 * Cost is complete-or-null: an unpriced ingredient, a trashed recipe, a recipe
 * without a finished weight or invalid labour makes the cost unknown — never a
 * flattering partial sum.
 *
 * Recipes enter a product at their INGREDIENT-ONLY cost (yield-adjusted: batch
 * ingredient cost ÷ finished weight). Recipe labour, energy and packaging are never
 * inherited: labour and extra costs belong to the Menu product, entered once there.
 *
 * Food vs packaging: recipe components are food. A direct ingredient counts as food
 * or packaging by its stored `cost_kind`; an unclassified one still costs into the
 * total, but the food-only ingredient margin stays unknown until it is classified.
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

/** Production labour for the whole batch: combined staff hours × employment cost per hour. Null = not entered. */
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

// ── Cost classification ──────────────────────────────────────────────────────

/**
 * What a direct ingredient counts as, stored on the ingredient (`cost_kind`).
 * NULL = not classified yet. Never inferred from a name or a unit (a piece can be
 * an egg as easily as a box).
 */
export const DISH_COST_KINDS = ['food', 'packaging'] as const;
export type DishCostKind = (typeof DISH_COST_KINDS)[number];

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
  /** Absent/null = not classified (food-only figures stay unknown while it is in a dish). */
  costKind?: DishCostKind | null;
};

export type DishRecipeCost = RecipeYield & {
  /**
   * Ingredient-only cost of ONE batch of the recipe (flattened sub-recipe
   * ingredients included; no labour, energy or packaging), unrounded cents.
   * Null = unknown (an unpriced ingredient or an unresolvable component tree).
   */
  ingredientCostCents: number | null;
};

export type DishCostLookups = {
  /** An ACTIVE recipe's yield + ingredient-only batch cost; null = unavailable. */
  recipe: (recipeId: string) => DishRecipeCost | null;
  ingredient: (ingredientId: string) => DishIngredientPrice | null;
};

/**
 * Cost of a recipe line from the recipe's ingredient-only batch cost: grams through
 * the finished weight (cost per kg, yield-adjusted), saved portions through the
 * portion yield. Null when that basis is missing — never guessed.
 */
export function recipeLineCostCents(amount: number, unit: DishRecipeUnit, recipe: DishRecipeCost): number | null {
  const batch = recipe.ingredientCostCents;
  if (!positiveFinite(amount) || batch == null || !nonNegativeFinite(batch)) return null;
  if (unit === 'portion') {
    return positiveFinite(recipe.yieldPortions) ? (batch * amount) / recipe.yieldPortions : null;
  }
  const grams = unit === 'kg' ? amount * 1000 : amount;
  return positiveFinite(recipe.yieldWeightGrams) ? (batch * grams) / recipe.yieldWeightGrams : null;
}

export const recipeLineKey = (recipeId: string) => `r:${recipeId}`;
export const ingredientLineKey = (ingredientId: string) => `i:${ingredientId}`;
export const LABOUR_KEY = 'labour';
export const extraKey = (index: number) => `extra:${index}`;

export type DishLineCost = { key: string; costCents: number | null };

export type DishCost = {
  /** Every ENTERED cost is known and the output is valid. Labour may still be not entered (`labourEntered`). */
  complete: boolean;
  /** False = labour left blank: unknown, not a confirmed zero. */
  labourEntered: boolean;
  /** Recipes (ingredient-only) + direct food; null while a food line is unknown or a direct line is unclassified. */
  foodCents: number | null;
  exactFoodCents: number | null;
  /** At least one recipe line or food-classified direct ingredient. */
  hasFoodLines: boolean;
  /** Direct packaging lines; null while one is unpriced. */
  packagingCents: number | null;
  /** Recipes + direct ingredients (food, packaging and unclassified); null while any is unknown. */
  componentsCents: number | null;
  /** Null when labour is not entered or can't be calculated. */
  productionLabourCents: number | null;
  labourHours: number | null;
  labourHourlyCents: number | null;
  extraWorkCents: number | null;
  extraWorkHours: number | null;
  expensesCents: number | null;
  /** Combined staff hours: production labour + extra work. Null while labour is not entered or invalid. */
  workHours: number | null;
  /** All entered costs; null unless `complete`. */
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
  /** Direct ingredient lines whose ingredient is neither food nor packaging yet. */
  unclassifiedKeys: string[];
};

export function compositionCost(dish: DishComposition, lookups: DishCostLookups): DishCost {
  const lineCosts: DishLineCost[] = [];
  const incompleteKeys: string[] = [];
  const unclassifiedKeys: string[] = [];
  let food = 0;
  let foodKnown = true;
  let packaging = 0;
  let packagingKnown = true;
  let unclassified = 0;
  let unclassifiedKnown = true;
  let hasFoodLines = dish.recipeLines.length > 0;

  for (const line of dish.recipeLines) {
    const key = recipeLineKey(line.recipeId);
    const recipe = lookups.recipe(line.recipeId);
    const cost = recipe ? recipeLineCostCents(line.quantity, line.unit, recipe) : null;
    lineCosts.push({ key, costCents: cost === null ? null : Math.round(cost) });
    if (cost === null) {
      foodKnown = false;
      incompleteKeys.push(key);
    } else food += cost;
  }

  for (const line of dish.ingredientLines) {
    const key = ingredientLineKey(line.ingredientId);
    const ing = lookups.ingredient(line.ingredientId);
    const cost =
      ing && !ing.needsPricing && nonNegativeFinite(ing.priceCents) && positiveFinite(line.quantity)
        ? (ing.priceCents * line.quantity) / CANONICAL_PER_PRICE_UNIT[ing.dimension]
        : null;
    lineCosts.push({ key, costCents: cost === null ? null : Math.round(cost) });
    if (cost === null) incompleteKeys.push(key);
    const kind = ing?.costKind ?? null;
    if (kind === 'food') {
      hasFoodLines = true;
      if (cost === null) foodKnown = false;
      else food += cost;
    } else if (kind === 'packaging') {
      if (cost === null) packagingKnown = false;
      else packaging += cost;
    } else {
      unclassifiedKeys.push(key);
      if (cost === null) unclassifiedKnown = false;
      else unclassified += cost;
    }
  }

  let labour: number | null = null;
  if (dish.labour !== null) {
    labour = workCents(dish.labour.hours, dish.labour.hourlyCents);
    if (labour === null) incompleteKeys.push(LABOUR_KEY);
  }

  let extraWork = 0;
  let extraWorkHours = 0;
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
    } else if (extra.kind === 'work') {
      extraWork += cents;
      extraWorkHours += extra.hours;
    } else expenses += cents;
  });

  const saleUnits = outputSaleUnits(dish.output);
  const hasComponents = dish.recipeLines.length + dish.ingredientLines.length > 0;
  const componentsKnown = foodKnown && packagingKnown && unclassifiedKnown;
  const labourValid = dish.labour === null || labour !== null;
  const total = food + packaging + unclassified + (labour ?? 0) + extraWork + expenses;
  const complete =
    hasComponents &&
    componentsKnown &&
    labourValid &&
    extrasValid &&
    saleUnits !== null &&
    Number.isFinite(total) &&
    Number.isSafeInteger(Math.round(total));
  const foodExact = foodKnown && unclassifiedKeys.length === 0 && Number.isFinite(food) ? food : null;

  const weightKg = outputWeightKg(dish.output);
  return {
    complete,
    labourEntered: dish.labour !== null,
    foodCents: foodExact === null ? null : Math.round(foodExact),
    exactFoodCents: foodExact,
    hasFoodLines,
    packagingCents: packagingKnown ? Math.round(packaging) : null,
    componentsCents: hasComponents && componentsKnown ? Math.round(food + packaging + unclassified) : null,
    productionLabourCents: labour === null ? null : Math.round(labour),
    labourHours: labour === null || dish.labour === null ? null : dish.labour.hours,
    labourHourlyCents: labour === null || dish.labour === null ? null : dish.labour.hourlyCents,
    extraWorkCents: extrasValid ? Math.round(extraWork) : null,
    extraWorkHours: extrasValid ? roundHours(extraWorkHours) : null,
    expensesCents: extrasValid ? Math.round(expenses) : null,
    workHours:
      labour !== null && dish.labour !== null && extrasValid ? roundHours(dish.labour.hours + extraWorkHours) : null,
    totalCostCents: complete ? Math.round(total) : null,
    exactTotalCents: complete ? total : null,
    saleUnits,
    costPerSaleUnitCents: complete && saleUnits ? Math.round(total / saleUnits) : null,
    costPerKgCents: complete && weightKg ? Math.round(total / weightKg) : null,
    lineCosts,
    incompleteKeys,
    unclassifiedKeys,
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

// ── Per-item results (the dish editor) ───────────────────────────────────────

export type DishResults = {
  priceExclCents: number | null;
  priceInclCents: number | null;
  /** Price excl. VAT × saleable items — assumes every item sells. */
  salesCents: number | null;
  exactSalesCents: number | null;
  /** All entered costs ÷ items. Null while a cost is unknown OR labour is not entered. */
  totalCostPerItemCents: number | null;
  exactTotalCostPerItemCents: number | null;
  /** Food (recipes + direct food) ÷ items. Packaging, labour and extras are excluded. */
  foodCostPerItemCents: number | null;
  exactFoodCostPerItemCents: number | null;
  /** (price excl. VAT − food cost) ÷ price. Not company profit. */
  ingredientMarginBps: number | null;
  /** Food cost ÷ price excl. VAT (100% − ingredient margin). */
  foodCostBps: number | null;
  /** Sales − all entered costs: what is left for other overheads and profit. */
  remainingCents: number | null;
  /** Remaining ÷ combined staff work hours. Null for missing or zero hours. */
  earnedPerWorkHourCents: number | null;
};

/**
 * The editor's three results, from the exact totals and rounded once:
 *  - total cost / item: every entered cost (recipes, direct ingredients incl.
 *    packaging, labour, extra work, expenses) ÷ items;
 *  - ingredient margin: food only — (sales − food) ÷ sales;
 *  - earned / work hour: (sales − every cost, labour included) ÷ combined staff hours.
 * Unentered labour is unknown, not zero, so the total-cost results wait for it while
 * the food-only margin does not. A missing price, cost or hour yields null — never a
 * zero, an infinity or a flattering figure. Losses stay negative.
 */
export function dishResults(cost: DishCost, priceExclCents: number | null, vatBps: number): DishResults {
  const price = priceExclCents != null && nonNegativeFinite(priceExclCents) ? priceExclCents : null;
  const items = positiveFinite(cost.saleUnits) ? cost.saleUnits : null;
  const sales = price !== null && items !== null ? price * items : null;
  const totalKnown = cost.exactTotalCents !== null && cost.labourEntered && items !== null;
  const totalPerItem = totalKnown ? (cost.exactTotalCents as number) / (items as number) : null;
  const foodPerItem =
    cost.exactFoodCents !== null && cost.hasFoodLines && items !== null ? cost.exactFoodCents / items : null;
  const priced = price !== null && price > 0;
  const remaining = priced && sales !== null && totalKnown ? sales - (cost.exactTotalCents as number) : null;
  const hours = cost.workHours;
  return {
    priceExclCents: price,
    priceInclCents: price === null ? null : priceInclVat(price, vatBps),
    salesCents: sales === null ? null : Math.round(sales),
    exactSalesCents: sales,
    totalCostPerItemCents: totalPerItem === null ? null : Math.round(totalPerItem),
    exactTotalCostPerItemCents: totalPerItem,
    foodCostPerItemCents: foodPerItem === null ? null : Math.round(foodPerItem),
    exactFoodCostPerItemCents: foodPerItem,
    ingredientMarginBps: priced && foodPerItem !== null ? Math.round(((price - foodPerItem) / price) * BPS) : null,
    foodCostBps: priced && foodPerItem !== null ? Math.round((foodPerItem / price) * BPS) : null,
    remainingCents: remaining === null ? null : Math.round(remaining),
    earnedPerWorkHourCents:
      remaining !== null && hours !== null && positiveFinite(hours) ? Math.round(remaining / hours) : null,
  };
}

/**
 * Net (excl. VAT) price per item that reaches `targetBps` INGREDIENT margin on the
 * food cost per item: food ÷ (1 − target). Rounded UP to the cent so the target is
 * never undershot (€2.0333 → €2.04). Labour, packaging and extras play no part.
 * Null for a missing/zero food cost or a target outside 0 ≤ target < 100%.
 */
export function priceForIngredientMargin(foodCostPerItemCents: number | null, targetBps: number): number | null {
  if (!positiveFinite(foodCostPerItemCents)) return null;
  if (!Number.isFinite(targetBps) || targetBps < 0 || targetBps >= BPS) return null;
  // toPrecision drops binary noise first, so an exact cent (203.99999…) stays 204.
  const cents = Math.ceil(Number((foodCostPerItemCents / (1 - targetBps / BPS)).toPrecision(12)));
  return Number.isSafeInteger(cents) && cents <= 2_147_483_647 ? cents : null;
}
