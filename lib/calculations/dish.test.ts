import { describe, expect, it } from 'vitest';
import {
  compositionCost,
  dishPricing,
  dishResults,
  ingredientCanonicalQuantity,
  ingredientDisplayAmount,
  ingredientUnitsFor,
  outputCanonicalQuantity,
  outputDisplayAmount,
  outputSaleUnits,
  outputWeightKg,
  priceBasisFor,
  priceExclVat,
  priceForIngredientMargin,
  priceForTotalCostShare,
  priceInclVat,
  recipeLineCostCents,
  recipePortionEquivalent,
  scaleComposition,
  type DishComposition,
  type DishCostLookups,
  type DishExtra,
} from './dish';

/**
 * Lookups for a tiny catalogue (ingredient-only recipe batch costs):
 *  - "base": 2 kg / 20 portions, ingredients €12 a batch (€6/kg, 60c/portion);
 *  - "noweight": €10 a batch, 10 portions, no finished weight;
 *  - "unpricedRecipe": a recipe with an unpriced ingredient (cost unknown);
 *  - "fruit" food 1200c/kg; "box" packaging 80c each; "sleeve" packaging 4c each;
 *    "loose" 50c each, not classified; "unpriced" food that needs pricing.
 */
const lookups: DishCostLookups = {
  recipe: (id) =>
    id === 'base'
      ? { yieldPortions: 20, yieldWeightGrams: 2_000, ingredientCostCents: 1_200 }
      : id === 'noweight'
        ? { yieldPortions: 10, yieldWeightGrams: null, ingredientCostCents: 1_000 }
        : id === 'unpricedRecipe'
          ? { yieldPortions: 10, yieldWeightGrams: 1_000, ingredientCostCents: null }
          : null,
  ingredient: (id) =>
    id === 'fruit'
      ? { dimension: 'weight', priceCents: 1_200, needsPricing: false, costKind: 'food' }
      : id === 'box'
        ? { dimension: 'count', priceCents: 80, needsPricing: false, costKind: 'packaging' }
        : id === 'sleeve'
          ? { dimension: 'count', priceCents: 4, needsPricing: false, costKind: 'packaging' }
          : id === 'loose'
            ? { dimension: 'count', priceCents: 50, needsPricing: false, costKind: null }
            : id === 'unpriced'
              ? { dimension: 'weight', priceCents: 0, needsPricing: true, costKind: 'food' }
              : null,
};

const count = (quantity: number, unit: 'piece' | 'cake' | 'portion' = 'piece', finishedWeightGrams: number | null = null) => ({
  quantity,
  unit,
  finishedWeightGrams,
});

function dish(patch: Partial<DishComposition> = {}): DishComposition {
  return {
    output: count(300),
    labour: null,
    extras: [],
    recipeLines: [],
    ingredientLines: [],
    ...patch,
  };
}

/**
 * The brief's worked example: 300 items at €3 excl. VAT; food €183 (10 kg of "base"
 * = €60 + 10.25 kg fruit = €123); packaging €12 (300 sleeves); 8 h × €20; €25 expenses.
 */
function workedExample(patch: Partial<DishComposition> = {}): DishComposition {
  return dish({
    labour: { hours: 8, hourlyCents: 2_000 },
    extras: [{ kind: 'expense', amountCents: 2_500 }],
    recipeLines: [{ recipeId: 'base', quantity: 10_000, unit: 'g' }],
    ingredientLines: [
      { ingredientId: 'fruit', quantity: 10_250, unit: 'g' },
      { ingredientId: 'sleeve', quantity: 300, unit: 'piece' },
    ],
    ...patch,
  });
}

describe('worked example (the brief)', () => {
  const cost = compositionCost(workedExample(), lookups);
  const results = dishResults(cost, 300, 0);

  it('splits food, packaging, labour and extras', () => {
    expect(cost.foodCents).toBe(18_300);
    expect(cost.packagingCents).toBe(1_200);
    expect(cost.componentsCents).toBe(19_500);
    expect(cost.productionLabourCents).toBe(16_000);
    expect(cost.expensesCents).toBe(2_500);
    expect(cost.workHours).toBe(8);
    expect(cost.totalCostCents).toBe(38_000);
  });

  it('gives the three results', () => {
    expect(results.salesCents).toBe(90_000);
    expect(results.totalCostPerItemCents).toBe(127); // €1.2667
    expect(results.ingredientMarginBps).toBe(7_967); // 79.7%
    expect(results.foodCostBps).toBe(2_033);
    expect(results.remainingCents).toBe(52_000);
    expect(results.earnedPerWorkHourCents).toBe(6_500); // €65
  });

  it('suggests €2.04 at a 70% target (rounded up from €2.0333, never undershooting)', () => {
    expect(results.exactFoodCostPerItemCents).toBe(61);
    const suggested = priceForIngredientMargin(results.exactFoodCostPerItemCents, 7_000);
    expect(suggested).toBe(204);
    // The applied price reaches at least the target.
    const applied = dishResults(cost, suggested, 0);
    expect(applied.ingredientMarginBps).toBeGreaterThanOrEqual(7_000);
    // …and the hourly result is recalculated from it: (612 − 380) € ÷ 8 h = €29.
    expect(applied.remainingCents).toBe(23_200);
    expect(applied.earnedPerWorkHourCents).toBe(2_900);
  });
});

describe('labour and extra work', () => {
  it('changing labour changes total cost and hourly earnings, not the ingredient margin or suggestion', () => {
    const base = dishResults(compositionCost(workedExample(), lookups), 300, 0);
    const more = dishResults(compositionCost(workedExample({ labour: { hours: 10, hourlyCents: 2_500 } }), lookups), 300, 0);
    expect(more.totalCostPerItemCents).toBe(157); // (380 − 160 + 250) / 300 = 1.5667
    expect(more.earnedPerWorkHourCents).toBe(4_300); // (900 − 470) / 10
    expect(more.ingredientMarginBps).toBe(base.ingredientMarginBps);
    expect(priceForIngredientMargin(more.exactFoodCostPerItemCents, 7_000)).toBe(
      priceForIngredientMargin(base.exactFoodCostPerItemCents, 7_000),
    );
  });

  it('extra work adds its hours and its cost exactly once', () => {
    const extras: DishExtra[] = [
      { kind: 'expense', amountCents: 2_500 },
      { kind: 'work', hours: 2, hourlyCents: 2_000 },
    ];
    const cost = compositionCost(workedExample({ extras }), lookups);
    expect(cost.extraWorkCents).toBe(4_000);
    expect(cost.extraWorkHours).toBe(2);
    expect(cost.productionLabourCents).toBe(16_000); // main labour untouched
    expect(cost.workHours).toBe(10);
    expect(cost.totalCostCents).toBe(42_000);
    const r = dishResults(cost, 300, 0);
    expect(r.remainingCents).toBe(48_000);
    expect(r.earnedPerWorkHourCents).toBe(4_800);
    expect(r.ingredientMarginBps).toBe(7_967);
  });

  it('unentered labour is unknown, not zero: totals wait, the food margin does not', () => {
    const cost = compositionCost(workedExample({ labour: null }), lookups);
    expect(cost.labourEntered).toBe(false);
    expect(cost.complete).toBe(true); // every ENTERED cost is known
    expect(cost.workHours).toBeNull();
    const r = dishResults(cost, 300, 0);
    expect(r.totalCostPerItemCents).toBeNull();
    expect(r.remainingCents).toBeNull();
    expect(r.earnedPerWorkHourCents).toBeNull();
    expect(r.ingredientMarginBps).toBe(7_967);
  });

  it('a deliberate zero is labour entered; zero hours show no hourly figure', () => {
    const cost = compositionCost(workedExample({ labour: { hours: 0, hourlyCents: 0 } }), lookups);
    expect(cost.productionLabourCents).toBe(0);
    expect(cost.workHours).toBe(0);
    const r = dishResults(cost, 300, 0);
    expect(r.totalCostPerItemCents).toBe(73); // (380 − 160) / 300
    expect(r.earnedPerWorkHourCents).toBeNull();
  });

  it('allows negative results', () => {
    const r = dishResults(compositionCost(workedExample(), lookups), 100, 0);
    expect(r.remainingCents).toBe(-8_000); // 300 − 380
    expect(r.earnedPerWorkHourCents).toBe(-1_000);
    expect(r.ingredientMarginBps).toBe(3_900);
    const loss = dishResults(compositionCost(workedExample(), lookups), 50, 0);
    expect(loss.ingredientMarginBps).toBe(-2_200); // food 61c on a 50c price
  });

  it('negative or non-finite labour/extras hide every total', () => {
    for (const labour of [
      { hours: -1, hourlyCents: 2_000 },
      { hours: 1, hourlyCents: -5 },
      { hours: Number.NaN, hourlyCents: 2_000 },
      { hours: 1, hourlyCents: Number.POSITIVE_INFINITY },
    ]) {
      const cost = compositionCost(workedExample({ labour }), lookups);
      expect(cost.complete).toBe(false);
      expect(cost.totalCostCents).toBeNull();
      expect(cost.productionLabourCents).toBeNull();
      expect(cost.workHours).toBeNull();
      expect(cost.incompleteKeys).toContain('labour');
      expect(dishResults(cost, 300, 0).earnedPerWorkHourCents).toBeNull();
    }
    const badExtra = compositionCost(workedExample({ extras: [{ kind: 'expense', amountCents: -1 }] }), lookups);
    expect(badExtra.totalCostCents).toBeNull();
    expect(badExtra.expensesCents).toBeNull();
  });

  it('decimal hours are exact until display', () => {
    const cost = compositionCost(
      dish({ output: count(3), labour: { hours: 1.25, hourlyCents: 1_999 }, ingredientLines: [{ ingredientId: 'box', quantity: 1, unit: 'piece' }] }),
      lookups,
    );
    // 1.25 × 1999 = 2498.75 → 2499; total 2578.75 → 2579; per piece 859.58 → 860
    expect(cost.productionLabourCents).toBe(2_499);
    expect(cost.totalCostCents).toBe(2_579);
    expect(cost.costPerSaleUnitCents).toBe(860);
  });
});

describe('food vs packaging', () => {
  it('packaging stays in total cost and hourly earnings but leaves the ingredient margin', () => {
    const withBoxes = workedExample({
      ingredientLines: [
        { ingredientId: 'fruit', quantity: 10_250, unit: 'g' },
        { ingredientId: 'sleeve', quantity: 300, unit: 'piece' },
        { ingredientId: 'box', quantity: 300, unit: 'piece' }, // +€240 packaging
      ],
    });
    const cost = compositionCost(withBoxes, lookups);
    expect(cost.packagingCents).toBe(25_200);
    expect(cost.foodCents).toBe(18_300);
    const r = dishResults(cost, 300, 0);
    expect(r.ingredientMarginBps).toBe(7_967); // unchanged
    expect(r.remainingCents).toBe(28_000); // 520 − 240
    expect(priceForIngredientMargin(r.exactFoodCostPerItemCents, 7_000)).toBe(204);
  });

  it('an unclassified item still costs, but the food-only figures stay unknown', () => {
    const cost = compositionCost(
      workedExample({
        ingredientLines: [
          { ingredientId: 'fruit', quantity: 10_250, unit: 'g' },
          { ingredientId: 'loose', quantity: 10, unit: 'piece' },
        ],
      }),
      lookups,
    );
    expect(cost.unclassifiedKeys).toEqual(['i:loose']);
    expect(cost.totalCostCents).toBe(37_300); // 183 + 5 + 160 + 25
    expect(cost.foodCents).toBeNull();
    const r = dishResults(cost, 300, 0);
    expect(r.ingredientMarginBps).toBeNull();
    expect(r.totalCostPerItemCents).toBe(124);
    expect(priceForIngredientMargin(r.exactFoodCostPerItemCents, 7_000)).toBeNull();
  });

  it('an unpriced packaging item hides the total but not the food margin', () => {
    const cost = compositionCost(
      workedExample({
        ingredientLines: [{ ingredientId: 'fruit', quantity: 10_250, unit: 'g' }, { ingredientId: 'ghostBox', quantity: 1, unit: 'piece' }],
      }),
      { ...lookups, ingredient: (id) => (id === 'ghostBox' ? { dimension: 'count', priceCents: 0, needsPricing: true, costKind: 'packaging' } : lookups.ingredient(id)) },
    );
    expect(cost.totalCostCents).toBeNull();
    expect(cost.packagingCents).toBeNull();
    expect(dishResults(cost, 300, 0).ingredientMarginBps).toBe(7_967);
  });

  it('an unpriced food item hides the food margin and the total', () => {
    const cost = compositionCost(workedExample({ ingredientLines: [{ ingredientId: 'unpriced', quantity: 10, unit: 'g' }] }), lookups);
    expect(cost.foodCents).toBeNull();
    expect(cost.totalCostCents).toBeNull();
    const r = dishResults(cost, 300, 0);
    expect(r.ingredientMarginBps).toBeNull();
    expect(r.totalCostPerItemCents).toBeNull();
  });

  it('a dish with only packaging has no ingredient margin to show', () => {
    const cost = compositionCost(dish({ ingredientLines: [{ ingredientId: 'box', quantity: 300, unit: 'piece' }] }), lookups);
    expect(cost.hasFoodLines).toBe(false);
    expect(dishResults(cost, 300, 0).ingredientMarginBps).toBeNull();
  });
});

describe('recipe components: ingredient-only, yield-adjusted', () => {
  it('costs grams through the finished weight and saved portions through the yield', () => {
    const base = { yieldPortions: 20, yieldWeightGrams: 2_000, ingredientCostCents: 1_200 };
    expect(recipeLineCostCents(500, 'g', base)).toBe(300); // €6/kg × 0.5 kg
    expect(recipeLineCostCents(0.5, 'kg', base)).toBe(300);
    expect(recipeLineCostCents(5, 'portion', base)).toBe(300);
    expect(recipeLineCostCents(500, 'g', { ...base, yieldWeightGrams: null })).toBeNull();
    expect(recipeLineCostCents(500, 'g', { ...base, ingredientCostCents: null })).toBeNull();
    expect(recipeLineCostCents(0, 'g', base)).toBeNull();
  });

  it('a recipe without a finished weight, a trashed or unpriced recipe is unknown — never partial', () => {
    const cost = compositionCost(
      dish({
        output: count(1),
        labour: { hours: 1, hourlyCents: 1_000 },
        recipeLines: [
          { recipeId: 'base', quantity: 200, unit: 'g' },
          { recipeId: 'noweight', quantity: 100, unit: 'g' },
          { recipeId: 'ghost', quantity: 1, unit: 'portion' },
          { recipeId: 'unpricedRecipe', quantity: 100, unit: 'g' },
        ],
      }),
      lookups,
    );
    expect(cost.lineCosts[0]).toEqual({ key: 'r:base', costCents: 120 });
    expect(cost.complete).toBe(false);
    expect(cost.foodCents).toBeNull();
    expect(cost.componentsCents).toBeNull();
    expect(cost.incompleteKeys).toEqual(['r:noweight', 'r:ghost', 'r:unpricedRecipe']);
  });

  it('a legacy portion line keeps costing as saved', () => {
    const cost = compositionCost(dish({ recipeLines: [{ recipeId: 'noweight', quantity: 3, unit: 'portion' }] }), lookups);
    expect(cost.lineCosts[0]).toEqual({ key: 'r:noweight', costCents: 300 });
  });
});

describe('item count', () => {
  it('changing the count spreads the same total, never rescales it', () => {
    const base = workedExample();
    const fewer = { ...base, output: count(250) };
    expect(compositionCost(base, lookups).totalCostCents).toBe(compositionCost(fewer, lookups).totalCostCents);
    expect(dishResults(compositionCost(fewer, lookups), 300, 0).totalCostPerItemCents).toBe(152);
  });

  it('missing items or price withhold results instead of guessing', () => {
    const noItems = dishResults(compositionCost(workedExample({ output: count(0) }), lookups), 300, 0);
    expect(noItems).toMatchObject({ salesCents: null, totalCostPerItemCents: null, ingredientMarginBps: null, earnedPerWorkHourCents: null });
    const cost = compositionCost(workedExample(), lookups);
    expect(dishResults(cost, null, 0)).toMatchObject({ salesCents: null, ingredientMarginBps: null, remainingCents: null });
    expect(dishResults(cost, 0, 0)).toMatchObject({ ingredientMarginBps: null, remainingCents: null, earnedPerWorkHourCents: null });
    expect(dishResults(cost, Number.NaN, 0).priceExclCents).toBeNull();
    // Without a price the total cost per item still shows.
    expect(dishResults(cost, null, 0).totalCostPerItemCents).toBe(127);
  });

  it('an empty batch is incomplete', () => {
    expect(compositionCost(dish(), lookups).complete).toBe(false);
  });

  it('handles large values safely', () => {
    const cost = compositionCost(
      dish({ output: count(1), labour: { hours: 0, hourlyCents: 0 }, ingredientLines: [{ ingredientId: 'box', quantity: 99_999_999, unit: 'piece' }] }),
      lookups,
    );
    expect(cost.totalCostCents).toBe(7_999_999_920);
  });
});

describe('suggested price for a target ingredient margin', () => {
  it('rounds up to the cent and keeps exact cents exact', () => {
    expect(priceForIngredientMargin(61, 7_000)).toBe(204); // 203.33 → 204
    expect(priceForIngredientMargin(60, 7_000)).toBe(200); // 199.999… float noise stays 200
    expect(priceForIngredientMargin(30, 0)).toBe(30);
    expect(priceForIngredientMargin(0.1, 9_999)).toBe(1_000);
  });

  it('rejects invalid targets and missing or zero food cost', () => {
    expect(priceForIngredientMargin(61, 10_000)).toBeNull();
    expect(priceForIngredientMargin(61, 12_000)).toBeNull();
    expect(priceForIngredientMargin(61, -100)).toBeNull();
    expect(priceForIngredientMargin(61, Number.NaN)).toBeNull();
    expect(priceForIngredientMargin(0, 7_000)).toBeNull();
    expect(priceForIngredientMargin(null, 7_000)).toBeNull();
    expect(priceForIngredientMargin(Number.POSITIVE_INFINITY, 7_000)).toBeNull();
  });
});

describe('VAT', () => {
  it('converts both ways with half-up rounding and clamps bad rates', () => {
    expect(priceInclVat(300, 1_350)).toBe(341); // 3.405 → 3.41
    expect(priceExclVat(341, 1_350)).toBe(300);
    expect(priceInclVat(1_000, 2_300)).toBe(1_230);
    expect(priceExclVat(1_230, 2_300)).toBe(1_000);
    expect(priceInclVat(204, 0)).toBe(204);
    expect(priceInclVat(1_000, Number.NaN)).toBe(1_000);
  });

  it('every excl → incl → excl round trip lands on the same net price', () => {
    for (const vat of [0, 600, 1_350, 2_100, 2_300]) {
      for (let net = 1; net <= 2_000; net += 7) {
        expect(priceExclVat(priceInclVat(net, vat), vat)).toBe(net);
      }
    }
  });

  it('results use the price excluding VAT', () => {
    const cost = compositionCost(workedExample(), lookups);
    const withVat = dishResults(cost, 300, 2_300);
    expect(withVat.priceInclCents).toBe(369);
    expect(withVat.salesCents).toBe(90_000);
    expect(withVat.earnedPerWorkHourCents).toBe(6_500);
  });
});

describe('batch output', () => {
  it('converts g ↔ kg without changing the canonical batch', () => {
    expect(outputCanonicalQuantity(20, 'kg')).toBe(20_000);
    expect(outputCanonicalQuantity(20_000, 'g')).toBe(20_000);
    expect(outputDisplayAmount(20_000, 'kg')).toBe(20);
    expect(outputDisplayAmount(50, 'cake')).toBe(50);
  });

  it('prices weight per kg and count per unit, and never infers weight', () => {
    expect(priceBasisFor('g')).toBe('kg');
    expect(priceBasisFor('cake')).toBe('unit');
    expect(outputSaleUnits({ quantity: 20_000, unit: 'g', finishedWeightGrams: null })).toBe(20);
    expect(outputSaleUnits(count(50, 'cake'))).toBe(50);
    expect(outputWeightKg(count(50, 'cake'))).toBeNull();
    expect(outputWeightKg(count(50, 'cake', 25_000))).toBe(25);
    expect(outputSaleUnits(count(0))).toBeNull();
    expect(outputSaleUnits(count(Number.NaN))).toBeNull();
  });

  it('weight batch: cost per kg and batch sales for the Menu list', () => {
    const inGrams = dish({
      output: { quantity: 20_000, unit: 'g', finishedWeightGrams: null },
      labour: { hours: 1, hourlyCents: 2_000 },
      ingredientLines: [{ ingredientId: 'fruit', quantity: 3_333.333_333, unit: 'g' }], // ≈ €40
    });
    const cost = compositionCost(inGrams, lookups);
    expect(cost.totalCostCents).toBe(6_000);
    expect(cost.costPerKgCents).toBe(300);
    const pricing = dishPricing(cost, 800, 0);
    expect(pricing.estimatedSalesCents).toBe(16_000);
    expect(pricing.amountLeftCents).toBe(10_000);
    expect(pricing.totalCostBps).toBe(3_750);
  });

  it('scaling doubles components and finished weight, not hours or expenses', () => {
    const original = dish({
      output: count(300, 'piece', 30_000),
      labour: { hours: 8, hourlyCents: 2_000 },
      extras: [{ kind: 'expense', amountCents: 1_500 }],
      recipeLines: [{ recipeId: 'base', quantity: 500, unit: 'g' }],
      ingredientLines: [{ ingredientId: 'box', quantity: 300, unit: 'piece' }],
    });
    const scaled = scaleComposition(original, 600);
    expect(scaled?.output).toEqual({ quantity: 600, unit: 'piece', finishedWeightGrams: 60_000 });
    expect(scaled?.recipeLines[0]?.quantity).toBe(1_000);
    expect(scaled?.labour).toEqual({ hours: 8, hourlyCents: 2_000 });
    expect(scaleComposition(original, 0)).toBeNull();
  });

  it('keeps the shared unit helpers', () => {
    expect(recipePortionEquivalent(400, 'g', { yieldPortions: 10, yieldWeightGrams: 2_000 })).toBe(2);
    expect(recipePortionEquivalent(400, 'g', { yieldPortions: 10, yieldWeightGrams: null })).toBeNull();
    expect(ingredientUnitsFor('volume')).toEqual(['ml', 'l']);
    expect(ingredientCanonicalQuantity(0.25, 'kg')).toBe(250);
    expect(ingredientDisplayAmount(1_500, 'l')).toBe(1.5);
    expect(priceForTotalCostShare(300, 3_000)).toBe(1_000);
  });

  it('batch pricing withholds results without cost or price and allows a loss', () => {
    expect(dishPricing({ exactTotalCents: 50_000, saleUnits: 300 }, 100, 0)).toMatchObject({ amountLeftCents: -20_000 });
    expect(dishPricing({ exactTotalCents: null, saleUnits: 300 }, 100, 0)).toMatchObject({ amountLeftCents: null, marginBps: null });
    expect(dishPricing({ exactTotalCents: 100, saleUnits: 3 }, 0, 0).marginBps).toBeNull();
  });
});
