import { describe, expect, it } from 'vitest';
import {
  compositionCost,
  dishPricing,
  ingredientCanonicalQuantity,
  ingredientDisplayAmount,
  ingredientUnitsFor,
  outputCanonicalQuantity,
  outputDisplayAmount,
  outputSaleUnits,
  outputWeightKg,
  priceBasisFor,
  priceExclVat,
  priceForMargin,
  priceForTotalCostShare,
  portionPricing,
  priceInclVat,
  recipePortionEquivalent,
  scaleComposition,
  type DishComposition,
  type DishCostLookups,
} from './dish';

/**
 * Lookups for a tiny catalogue:
 *  - "base": a 2 kg / 20-portion recipe costing 100c/portion WITH labour, 60c without
 *    (its own + nested sub-recipe labour = 40c/portion);
 *  - "nolabour": 50c/portion either way;
 *  - "box" (count, 80c each), "fruit" (weight, 1200c/kg), "unpriced" needs pricing.
 */
const lookups: DishCostLookups = {
  recipeCostPerPortion: (id, { excludeLabour }) =>
    id === 'base' ? (excludeLabour ? 60 : 100) : id === 'nolabour' ? 50 : null,
  recipeYield: (id) =>
    id === 'base' || id === 'nolabour' ? { yieldPortions: 20, yieldWeightGrams: 2_000 } : null,
  ingredient: (id) =>
    id === 'box'
      ? { dimension: 'count', priceCents: 80, needsPricing: false }
      : id === 'fruit'
        ? { dimension: 'weight', priceCents: 1_200, needsPricing: false }
        : id === 'unpriced'
          ? { dimension: 'weight', priceCents: 0, needsPricing: true }
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

describe('batch output', () => {
  it('converts g ↔ kg without changing the canonical batch', () => {
    expect(outputCanonicalQuantity(20, 'kg')).toBe(20_000);
    expect(outputCanonicalQuantity(20_000, 'g')).toBe(20_000);
    expect(outputDisplayAmount(20_000, 'kg')).toBe(20);
    expect(outputDisplayAmount(50, 'cake')).toBe(50);
  });

  it('prices weight per kg and count per unit, and never infers weight', () => {
    expect(priceBasisFor('g')).toBe('kg');
    expect(priceBasisFor('kg')).toBe('kg');
    expect(priceBasisFor('cake')).toBe('unit');
    expect(outputSaleUnits({ quantity: 20_000, unit: 'g', finishedWeightGrams: null })).toBe(20);
    expect(outputSaleUnits(count(50, 'cake'))).toBe(50);
    expect(outputWeightKg(count(50, 'cake'))).toBeNull();
    expect(outputWeightKg(count(50, 'cake', 25_000))).toBe(25);
    expect(outputSaleUnits(count(0))).toBeNull();
    expect(outputSaleUnits(count(Number.NaN))).toBeNull();
  });
});

describe('acceptance examples', () => {
  it('A — count batch with production labour replacing recipe labour', () => {
    // Components €240 (300 boxes × 80c) + 8 h × €20.
    const cost = compositionCost(
      dish({
        labour: { hours: 8, hourlyCents: 2_000 },
        ingredientLines: [{ ingredientId: 'box', quantity: 300, unit: 'piece' }],
      }),
      lookups,
    );
    expect(cost.componentsCents).toBe(24_000);
    expect(cost.productionLabourCents).toBe(16_000);
    expect(cost.totalCostCents).toBe(40_000);
    expect(cost.costPerSaleUnitCents).toBe(133); // €1.33
    expect(cost.labourMode).toBe('menu');
  });

  it('A — recipe labour is not added again, energy/packaging kept', () => {
    const withMenuLabour = compositionCost(
      dish({
        output: count(20, 'portion'),
        labour: { hours: 1, hourlyCents: 2_000 },
        recipeLines: [{ recipeId: 'base', quantity: 20, unit: 'portion' }],
      }),
      lookups,
    );
    // 20 portions × 60c (labour excluded, incl. nested) + €20 labour
    expect(withMenuLabour.componentsCents).toBe(1_200);
    expect(withMenuLabour.totalCostCents).toBe(3_200);
    expect(withMenuLabour.inheritsRecipeLabour).toBe(false);
  });

  it('B — extra work and expenses', () => {
    const cost = compositionCost(
      dish({
        labour: { hours: 8, hourlyCents: 2_000 },
        extras: [
          { kind: 'work', hours: 2, hourlyCents: 2_000 },
          { kind: 'expense', amountCents: 1_500 },
        ],
        ingredientLines: [{ ingredientId: 'box', quantity: 300, unit: 'piece' }],
      }),
      lookups,
    );
    expect(cost.extraWorkCents).toBe(4_000);
    expect(cost.expensesCents).toBe(1_500);
    expect(cost.totalCostCents).toBe(45_500);
    expect(cost.costPerSaleUnitCents).toBe(152); // €1.52 (151.67)
  });

  it('C — weight batch: cost per kg, sales and amount left; g ↔ kg changes nothing', () => {
    const inGrams = dish({
      output: { quantity: 20_000, unit: 'g', finishedWeightGrams: null },
      labour: { hours: 1, hourlyCents: 2_000 },
      ingredientLines: [{ ingredientId: 'fruit', quantity: 3_333.333_333, unit: 'g' }], // ≈ €40
    });
    const inKg = { ...inGrams, output: { ...inGrams.output, unit: 'kg' as const } };
    for (const d of [inGrams, inKg]) {
      const cost = compositionCost(d, lookups);
      expect(cost.componentsCents).toBe(4_000);
      expect(cost.totalCostCents).toBe(6_000);
      expect(cost.costPerKgCents).toBe(300);
      expect(cost.costPerSaleUnitCents).toBe(300);
      const pricing = dishPricing(cost, 800, 0);
      expect(pricing.estimatedSalesCents).toBe(16_000);
      expect(pricing.amountLeftCents).toBe(10_000);
      expect(pricing.totalCostBps).toBe(3_750);
    }
  });

  it('D — cakes with a size description: per cake, weight optional and never inferred', () => {
    const noWeight = compositionCost(
      dish({ output: count(50, 'cake'), ingredientLines: [{ ingredientId: 'box', quantity: 50, unit: 'piece' }] }),
      lookups,
    );
    expect(noWeight.costPerSaleUnitCents).toBe(80);
    expect(noWeight.costPerKgCents).toBeNull();
    const withWeight = compositionCost(
      dish({ output: count(50, 'cake', 40_000), ingredientLines: [{ ingredientId: 'box', quantity: 50, unit: 'piece' }] }),
      lookups,
    );
    expect(withWeight.costPerKgCents).toBe(100); // €40 / 40 kg
  });

  it('E — scaling doubles components and finished weight, not hours or expenses', () => {
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
    expect(scaled?.ingredientLines[0]?.quantity).toBe(600);
    expect(scaled?.labour).toEqual({ hours: 8, hourlyCents: 2_000 });
    expect(scaled?.extras).toEqual([{ kind: 'expense', amountCents: 1_500 }]);
    expect(original.recipeLines[0]?.quantity).toBe(500); // original untouched
    expect(scaleComposition(original, 0)).toBeNull();
    expect(scaleComposition(dish({ output: count(0) }), 10)).toBeNull();
  });

  it('E — correcting the yield keeps components and changes cost per unit only', () => {
    const base = dish({ ingredientLines: [{ ingredientId: 'box', quantity: 300, unit: 'piece' }] });
    const corrected = { ...base, output: count(250) };
    expect(compositionCost(base, lookups).totalCostCents).toBe(compositionCost(corrected, lookups).totalCostCents);
    expect(compositionCost(corrected, lookups).costPerSaleUnitCents).toBe(96);
  });
});

describe('labour: blank vs zero vs invalid', () => {
  const recipe = [{ recipeId: 'base', quantity: 20, unit: 'portion' as const }];
  const output = count(20, 'portion');

  it('blank labour keeps legacy recipe costs and flags inherited labour', () => {
    const cost = compositionCost(dish({ output, recipeLines: recipe }), lookups);
    expect(cost.labourMode).toBe('inherited');
    expect(cost.totalCostCents).toBe(2_000); // 20 × 100c incl. recipe labour
    expect(cost.productionLabourCents).toBeNull();
    expect(cost.inheritsRecipeLabour).toBe(true);
    const plain = compositionCost(dish({ output, recipeLines: [{ recipeId: 'nolabour', quantity: 1, unit: 'portion' }] }), lookups);
    expect(plain.inheritsRecipeLabour).toBe(false);
  });

  it('a deliberate zero is menu labour: recipe labour excluded, labour 0', () => {
    const cost = compositionCost(dish({ output, recipeLines: recipe, labour: { hours: 0, hourlyCents: 0 } }), lookups);
    expect(cost.labourMode).toBe('menu');
    expect(cost.productionLabourCents).toBe(0);
    expect(cost.totalCostCents).toBe(1_200);
  });

  it('negative or non-finite labour/extras hide every total', () => {
    for (const labour of [
      { hours: -1, hourlyCents: 2_000 },
      { hours: 1, hourlyCents: -5 },
      { hours: Number.NaN, hourlyCents: 2_000 },
      { hours: 1, hourlyCents: Number.POSITIVE_INFINITY },
    ]) {
      const cost = compositionCost(dish({ output, recipeLines: recipe, labour }), lookups);
      expect(cost.complete).toBe(false);
      expect(cost.totalCostCents).toBeNull();
      expect(cost.productionLabourCents).toBeNull();
      expect(cost.incompleteKeys).toContain('labour');
    }
    const badExtra = compositionCost(
      dish({ output, recipeLines: recipe, extras: [{ kind: 'expense', amountCents: -1 }] }),
      lookups,
    );
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

describe('components', () => {
  it('converts recipe grams through the batch weight and is incomplete — never partial', () => {
    const cost = compositionCost(
      dish({
        output: count(1),
        recipeLines: [
          { recipeId: 'nolabour', quantity: 200, unit: 'g' }, // 2 portions × 50c
          { recipeId: 'ghost', quantity: 1, unit: 'portion' },
        ],
        ingredientLines: [{ ingredientId: 'unpriced', quantity: 10, unit: 'g' }],
      }),
      lookups,
    );
    expect(cost.lineCosts[0]).toEqual({ key: 'r:nolabour', costCents: 100 });
    expect(cost.complete).toBe(false);
    expect(cost.componentsCents).toBeNull();
    expect(cost.incompleteKeys).toEqual(['r:ghost', 'i:unpriced']);
  });

  it('an empty batch or zero output is incomplete', () => {
    expect(compositionCost(dish(), lookups).complete).toBe(false);
    expect(
      compositionCost(dish({ output: count(0), ingredientLines: [{ ingredientId: 'box', quantity: 1, unit: 'piece' }] }), lookups)
        .totalCostCents,
    ).toBeNull();
  });

  it('handles large values safely', () => {
    const cost = compositionCost(
      dish({ output: count(1), ingredientLines: [{ ingredientId: 'box', quantity: 99_999_999, unit: 'piece' }] }),
      lookups,
    );
    expect(cost.totalCostCents).toBe(7_999_999_920);
  });

  it('recipe portion equivalents need a batch weight for g/kg', () => {
    expect(recipePortionEquivalent(400, 'g', { yieldPortions: 10, yieldWeightGrams: 2_000 })).toBe(2);
    expect(recipePortionEquivalent(0.4, 'kg', { yieldPortions: 10, yieldWeightGrams: 2_000 })).toBe(2);
    expect(recipePortionEquivalent(400, 'g', { yieldPortions: 10, yieldWeightGrams: null })).toBeNull();
    expect(recipePortionEquivalent(3, 'portion', { yieldPortions: 1, yieldWeightGrams: null })).toBe(3);
    expect(ingredientUnitsFor('volume')).toEqual(['ml', 'l']);
    expect(ingredientCanonicalQuantity(0.25, 'kg')).toBe(250);
    expect(ingredientDisplayAmount(1_500, 'l')).toBe(1.5);
  });
});

describe('pricing', () => {
  it('converts VAT with half-up rounding and clamps bad rates', () => {
    expect(priceInclVat(1_000, 2_300)).toBe(1_230);
    expect(priceExclVat(1_230, 2_300)).toBe(1_000);
    expect(priceInclVat(1_000, Number.NaN)).toBe(1_000);
  });

  it('derives price for a margin or total-cost share from the exact unit cost', () => {
    expect(priceForMargin(300, 7_000)).toBe(1_000);
    expect(priceForMargin(133.333, 7_000)).toBe(444);
    expect(priceForTotalCostShare(300, 3_000)).toBe(1_000);
    expect(priceForMargin(300, 10_000)).toBeNull();
    expect(priceForMargin(null, 5_000)).toBeNull();
    expect(priceForTotalCostShare(300, 0)).toBeNull();
  });

  it('shows a negative amount left and withholds results without cost or price', () => {
    expect(dishPricing({ exactTotalCents: 50_000, saleUnits: 300 }, 100, 0)).toMatchObject({
      estimatedSalesCents: 30_000,
      amountLeftCents: -20_000,
    });
    expect(dishPricing({ exactTotalCents: null, saleUnits: 300 }, 100, 0)).toMatchObject({
      estimatedSalesCents: 30_000,
      amountLeftCents: null,
      marginBps: null,
    });
    expect(dishPricing({ exactTotalCents: 100, saleUnits: 3 }, null, 2_300)).toMatchObject({
      priceExclCents: null,
      estimatedSalesCents: null,
    });
    expect(dishPricing({ exactTotalCents: 100, saleUnits: 3 }, 0, 0).marginBps).toBeNull();
  });

  it('rounds batch sales from the exact product, not from a rounded unit', () => {
    // 20.5 kg × 333c = 6826.5 → 6827
    expect(dishPricing({ exactTotalCents: 1, saleUnits: 20.5 }, 333, 0).estimatedSalesCents).toBe(6_827);
  });
});

describe('portion pricing (dish editor margin calculator)', () => {
  it('matches the brief example: 10 portions, €60 total, €15 → €9 left, 60%', () => {
    const cost = compositionCost(
      dish({
        output: count(10, 'portion'),
        labour: { hours: 1, hourlyCents: 2_000 }, // €20
        extras: [{ kind: 'expense', amountCents: 1_000 }], // €10
        ingredientLines: [{ ingredientId: 'fruit', quantity: 2_500, unit: 'g' }], // €30
      }),
      lookups,
    );
    expect(cost.totalCostCents).toBe(6_000);
    const p = portionPricing(cost, 1_500, 1_300);
    expect(p).toEqual({
      priceExclCents: 1_500,
      priceInclCents: 1_695,
      costPerPortionCents: 600,
      exactCostPerPortionCents: 600,
      amountLeftPerPortionCents: 900,
      marginBps: 6_000,
      totalCostBps: 4_000,
    });
  });

  it('uses margin, not markup, for the suggested price (€4 cost at 60% → €10)', () => {
    expect(priceForMargin(400, 6_000)).toBe(1_000);
  });

  it('changing portions redistributes the same total, never rescales it', () => {
    const base = dish({ output: count(1, 'portion'), ingredientLines: [{ ingredientId: 'box', quantity: 12, unit: 'piece' }] });
    const twelve = { ...base, output: count(12, 'portion') };
    expect(compositionCost(base, lookups).totalCostCents).toBe(960);
    expect(compositionCost(twelve, lookups).totalCostCents).toBe(960);
    expect(portionPricing(compositionCost(twelve, lookups), 200, 0).costPerPortionCents).toBe(80);
  });

  it('keeps exact precision: rounds per-portion figures from the exact total', () => {
    // €10.00 over 3 portions = 333.33c; price 500 → left 166.67 → 167, margin 33.33% → 3333
    const p = portionPricing({ exactTotalCents: 1_000, saleUnits: 3 }, 500, 0);
    expect(p.costPerPortionCents).toBe(333);
    expect(p.amountLeftPerPortionCents).toBe(167);
    expect(p.marginBps).toBe(3_333);
  });

  it('shows nothing misleading when price or cost is missing, and allows a loss', () => {
    expect(portionPricing({ exactTotalCents: null, saleUnits: 10 }, 1_500, 0)).toMatchObject({
      priceInclCents: 1_500,
      costPerPortionCents: null,
      amountLeftPerPortionCents: null,
      marginBps: null,
    });
    expect(portionPricing({ exactTotalCents: 6_000, saleUnits: 10 }, null, 0)).toMatchObject({
      costPerPortionCents: 600,
      amountLeftPerPortionCents: null,
      marginBps: null,
    });
    expect(portionPricing({ exactTotalCents: 6_000, saleUnits: 10 }, 0, 0).marginBps).toBeNull();
    expect(portionPricing({ exactTotalCents: 6_000, saleUnits: 10 }, 500, 0)).toMatchObject({
      amountLeftPerPortionCents: -100,
      marginBps: -2_000,
    });
    expect(portionPricing({ exactTotalCents: 6_000, saleUnits: null }, 500, 0).costPerPortionCents).toBeNull();
  });
});
