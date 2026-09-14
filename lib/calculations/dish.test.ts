import { describe, expect, it } from 'vitest';
import {
  dishCost,
  dishPricing,
  ingredientCanonicalQuantity,
  ingredientDisplayAmount,
  ingredientUnitsFor,
  priceExclVat,
  priceForFoodCost,
  priceForMargin,
  priceInclVat,
  recipePortionEquivalent,
} from './dish';

const SPONGE = { yieldPortions: 10, yieldWeightGrams: 2_000 };

describe('units', () => {
  it('lists units per dimension and converts to canonical', () => {
    expect(ingredientUnitsFor('weight')).toEqual(['g', 'kg']);
    expect(ingredientUnitsFor('volume')).toEqual(['ml', 'l']);
    expect(ingredientUnitsFor('count')).toEqual(['piece']);
    expect(ingredientCanonicalQuantity(0.25, 'kg')).toBe(250);
    expect(ingredientCanonicalQuantity(2, 'piece')).toBe(2);
    expect(ingredientDisplayAmount(1500, 'l')).toBe(1.5);
  });
});

describe('recipePortionEquivalent', () => {
  it('maps portions 1:1 and grams through the batch weight', () => {
    expect(recipePortionEquivalent(3, 'portion', SPONGE)).toBe(3);
    // 400 g of a 2 kg / 10-portion batch = 2 portions
    expect(recipePortionEquivalent(400, 'g', SPONGE)).toBe(2);
    expect(recipePortionEquivalent(0.4, 'kg', SPONGE)).toBe(2);
  });

  it('returns null without a usable batch weight or amount', () => {
    expect(recipePortionEquivalent(400, 'g', { yieldPortions: 10, yieldWeightGrams: null })).toBeNull();
    expect(recipePortionEquivalent(400, 'g', { yieldPortions: 10, yieldWeightGrams: 0 })).toBeNull();
    expect(recipePortionEquivalent(400, 'g', { yieldPortions: 0, yieldWeightGrams: 2000 })).toBeNull();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(recipePortionEquivalent(bad, 'portion', SPONGE)).toBeNull();
    }
    // A portion line needs no batch weight.
    expect(recipePortionEquivalent(1, 'portion', { yieldPortions: 1, yieldWeightGrams: null })).toBe(1);
  });
});

describe('dishCost', () => {
  it('sums recipe and ingredient lines and divides across portions', () => {
    const cost = dishCost({
      portions: 8,
      recipeLines: [
        { key: 'sponge', costPerPortionCents: 150, portionEquivalent: 2 }, // 300
        { key: 'curd', costPerPortionCents: 99, portionEquivalent: 1.5 }, // 148.5
      ],
      ingredientLines: [
        { key: 'fruit', dimension: 'weight', priceCents: 1_200, quantity: 125 }, // 150
        { key: 'box', dimension: 'count', priceCents: 85, quantity: 1 }, // 85
        { key: 'cream', dimension: 'volume', priceCents: 600, quantity: 250 }, // 150
      ],
    });
    expect(cost.complete).toBe(true);
    // 300 + 148.5 + 150 + 85 + 150 = 833.5 → 834 (rounded once)
    expect(cost.totalCostCents).toBe(834);
    expect(cost.costPerPortionCents).toBe(104);
    expect(cost.lineCosts).toEqual([
      { key: 'sponge', costCents: 300 },
      { key: 'curd', costCents: 149 },
      { key: 'fruit', costCents: 150 },
      { key: 'box', costCents: 85 },
      { key: 'cream', costCents: 150 },
    ]);
  });

  it('is incomplete — never partial — when any line is unknown', () => {
    const cost = dishCost({
      portions: 1,
      recipeLines: [
        { key: 'a', costPerPortionCents: 100, portionEquivalent: 1 },
        { key: 'noweight', costPerPortionCents: 100, portionEquivalent: null },
        { key: 'unpriced', costPerPortionCents: null, portionEquivalent: 1 },
      ],
      ingredientLines: [{ key: 'x', dimension: 'weight', priceCents: null, quantity: 10 }],
    });
    expect(cost.complete).toBe(false);
    expect(cost.totalCostCents).toBeNull();
    expect(cost.costPerPortionCents).toBeNull();
    expect(cost.incompleteKeys).toEqual(['noweight', 'unpriced', 'x']);
    expect(cost.lineCosts[0]).toEqual({ key: 'a', costCents: 100 });
  });

  it('treats an empty dish, bad portions and non-finite values as incomplete', () => {
    expect(dishCost({ portions: 1, recipeLines: [], ingredientLines: [] }).complete).toBe(false);
    const line = { key: 'a', costPerPortionCents: 100, portionEquivalent: 1 };
    for (const portions of [0, -1, 1.5, Number.NaN]) {
      expect(dishCost({ portions, recipeLines: [line], ingredientLines: [] }).complete).toBe(false);
    }
    expect(
      dishCost({
        portions: 1,
        recipeLines: [{ key: 'a', costPerPortionCents: Number.POSITIVE_INFINITY, portionEquivalent: 1 }],
        ingredientLines: [],
      }).complete,
    ).toBe(false);
    expect(
      dishCost({
        portions: 1,
        recipeLines: [],
        ingredientLines: [{ key: 'x', dimension: 'count', priceCents: -5, quantity: 1 }],
      }).complete,
    ).toBe(false);
  });

  it('adds whole-dish adjustments and rejects invalid ones', () => {
    const base = { portions: 2, recipeLines: [{ key: 'a', costPerPortionCents: 100, portionEquivalent: 2 }], ingredientLines: [] };
    expect(dishCost({ ...base, adjustments: [{ kind: 'labour', cents: 300 }] }).totalCostCents).toBe(500);
    expect(dishCost({ ...base, adjustments: [{ kind: 'waste', cents: -1 }] }).complete).toBe(false);
  });

  it('keeps a zero-priced ingredient as a real zero (not unpriced)', () => {
    const cost = dishCost({
      portions: 1,
      recipeLines: [],
      ingredientLines: [{ key: 'herb', dimension: 'weight', priceCents: 0, quantity: 5 }],
    });
    expect(cost.complete).toBe(true);
    expect(cost.totalCostCents).toBe(0);
  });

  it('handles large values safely', () => {
    const cost = dishCost({
      portions: 1,
      recipeLines: [{ key: 'a', costPerPortionCents: 9_000_000, portionEquivalent: 1_000 }],
      ingredientLines: [],
    });
    expect(cost.totalCostCents).toBe(9_000_000_000);
  });
});

describe('pricing', () => {
  it('converts between net and gross with half-up VAT', () => {
    expect(priceInclVat(1_000, 2_300)).toBe(1_230);
    expect(priceExclVat(1_230, 2_300)).toBe(1_000);
    expect(priceInclVat(999, 1_300)).toBe(1_129); // 129.87 → 130
    expect(priceInclVat(1_000, 0)).toBe(1_000);
    // Invalid rates clamp instead of producing NaN.
    expect(priceInclVat(1_000, Number.NaN)).toBe(1_000);
    expect(priceInclVat(1_000, 50_000)).toBe(2_000);
  });

  it('derives the price for a target margin or food cost', () => {
    expect(priceForMargin(300, 7_000)).toBe(1_000);
    expect(priceForMargin(117, 7_000)).toBe(390);
    expect(priceForMargin(300, 0)).toBe(300);
    expect(priceForFoodCost(300, 3_000)).toBe(1_000);
    expect(priceForFoodCost(300, 10_000)).toBe(300);
  });

  it('refuses impossible targets and unknown costs', () => {
    expect(priceForMargin(300, 10_000)).toBeNull();
    expect(priceForMargin(300, -1)).toBeNull();
    expect(priceForMargin(null, 7_000)).toBeNull();
    expect(priceForMargin(0, 7_000)).toBeNull();
    expect(priceForMargin(300, Number.NaN)).toBeNull();
    expect(priceForFoodCost(300, 0)).toBeNull();
    expect(priceForFoodCost(300, 10_001)).toBeNull();
  });

  it('computes per-portion KPIs', () => {
    expect(dishPricing(300, 1_000, 2_300)).toEqual({
      priceExclCents: 1_000,
      priceInclCents: 1_230,
      grossProfitCents: 700,
      marginBps: 7_000,
      foodCostBps: 3_000,
    });
  });

  it('allows negative margin and withholds KPIs without price or cost', () => {
    expect(dishPricing(1_500, 1_000, 0)).toMatchObject({ grossProfitCents: -500, marginBps: -5_000, foodCostBps: 15_000 });
    expect(dishPricing(null, 1_000, 0)).toMatchObject({ priceInclCents: 1_000, marginBps: null, grossProfitCents: null });
    expect(dishPricing(300, null, 0)).toMatchObject({ priceExclCents: null, priceInclCents: null, marginBps: null });
    expect(dishPricing(300, 0, 0)).toMatchObject({ priceExclCents: 0, marginBps: null, foodCostBps: null });
  });
});
