import { describe, expect, it } from 'vitest';
import { componentCost } from '@/lib/calculations/componentCost';
import {
  explodeProduction,
  shortfallVsStock,
  NUMERIC_12_2_MAX,
  type ProductionRecipeInput,
} from '@/lib/calculations/production';
import { recipeCost } from '@/lib/calculations/recipeCost';

/** A minimal active recipe input for the explosion. */
function recipe(
  recipeId: string,
  plannedQty: number,
  lines: { ingredientId: string; quantity: number }[],
  extra: Partial<ProductionRecipeInput> = {},
): ProductionRecipeInput {
  return {
    recipeId,
    plannedQty,
    available: true,
    yieldPortions: 1,
    yieldPercentage: 100,
    lines,
    ...extra,
  };
}

describe('componentCost (shared sum, D10)', () => {
  it('sums costPerPortionCents × quantity when every component is available', () => {
    const result = componentCost([
      { id: 'a', costPerPortionCents: 200, quantity: 2 },
      { id: 'b', costPerPortionCents: 300, quantity: 1 },
    ]);
    expect(result).toEqual({ complete: true, costCents: 700, unavailableIds: [] });
  });

  it('is incomplete (null, names the unavailable) when a component is unavailable', () => {
    const result = componentCost([
      { id: 'a', costPerPortionCents: 200, quantity: 2 },
      { id: 'b', costPerPortionCents: null, quantity: 1 },
    ]);
    expect(result.complete).toBe(false);
    expect(result.costCents).toBeNull();
    expect(result.complete === false && result.unavailableIds).toEqual(['b']);
  });

  it('rejects an overflowing total rather than clamping', () => {
    const result = componentCost([
      { id: 'a', costPerPortionCents: Number.MAX_SAFE_INTEGER, quantity: 2 },
    ]);
    expect(result.complete).toBe(false);
    expect(result.costCents).toBeNull();
  });

  it('is defensively incomplete for an empty component set', () => {
    expect(componentCost([]).complete).toBe(false);
  });
});

describe('explodeProduction (mise-en-place)', () => {
  it('scales a single recipe by planned portions', () => {
    const result = explodeProduction([
      recipe('r1', 5, [{ ingredientId: 'flour', quantity: 100 }]),
    ]);
    expect(result.complete).toBe(true);
    expect(result.complete && result.requirements).toEqual([
      { ingredientId: 'flour', quantityCanonical: 500 },
    ]);
  });

  it('aggregates the same ingredient across recipes, rounding ONCE after the sum', () => {
    // Each recipe contributes 1/3 of a unit; 0.3333 + 0.3333 = 0.6667 → 0.67.
    // Rounding each contribution first would give 0.33 + 0.33 = 0.66.
    const result = explodeProduction([
      recipe('r1', 1, [{ ingredientId: 'salt', quantity: 1 }], { yieldPortions: 3 }),
      recipe('r2', 1, [{ ingredientId: 'salt', quantity: 1 }], { yieldPortions: 3 }),
    ]);
    expect(result.complete).toBe(true);
    expect(result.complete && result.requirements).toEqual([
      { ingredientId: 'salt', quantityCanonical: 0.67 },
    ]);
  });

  it('reconciles the yield/loss convention with recipeCost', () => {
    // yieldPortions 4, 50% yield, line 100g, 8 portions:
    //   needed = 100 × 8 / 4 / 0.5 = 400.
    const result = explodeProduction([
      recipe('r1', 8, [{ ingredientId: 'butter', quantity: 100 }], {
        yieldPortions: 4,
        yieldPercentage: 50,
      }),
    ]);
    expect(result.complete && result.requirements[0]?.quantityCanonical).toBe(400);

    // The per-portion ingredient cost from recipeCost uses the same loss/yield math,
    // so an ingredient priced at 1000c/kg over 100g → cost mirrors the explosion ratio.
    const cost = recipeCost({
      yieldPortions: 4,
      yieldPercentage: 50,
      laborCostCents: 0,
      energyCostCents: 0,
      packagingCostCents: 0,
      lines: [{ dimension: 'weight', priceCents: 1000, quantity: 100 }],
    });
    // ingredientCost = (1000 × 100 / 1000) / 0.5 = 200; per portion = 200 / 4 = 50.
    expect(cost.costPerPortionCents).toBe(50);
  });

  it('sorts requirements deterministically by ingredient id', () => {
    const result = explodeProduction([
      recipe('r1', 1, [
        { ingredientId: 'zucchini', quantity: 1 },
        { ingredientId: 'apple', quantity: 1 },
        { ingredientId: 'mango', quantity: 1 },
      ]),
    ]);
    expect(
      result.complete && result.requirements.map((r) => r.ingredientId),
    ).toEqual(['apple', 'mango', 'zucchini']);
  });

  it('marks an unavailable recipe incomplete (never a zero requirement)', () => {
    const result = explodeProduction([
      recipe('r1', 2, [{ ingredientId: 'flour', quantity: 100 }]),
      recipe('r2', 2, [{ ingredientId: 'sugar', quantity: 50 }], { available: false }),
    ]);
    expect(result.complete).toBe(false);
    if (result.complete) return;
    expect(result.reason).toBe('recipe_unavailable');
    expect(result.unavailableRecipeIds).toEqual(['r2']);
    // The preview carries only the available recipe's contribution (never sugar=0).
    expect(result.partialRequirements).toEqual([
      { ingredientId: 'flour', quantityCanonical: 200 },
    ]);
  });

  it('rejects duplicate recipe ids and an empty item set as invalid_math', () => {
    expect(explodeProduction([]).complete).toBe(false);
    const dup = explodeProduction([
      recipe('r1', 1, [{ ingredientId: 'a', quantity: 1 }]),
      recipe('r1', 1, [{ ingredientId: 'a', quantity: 1 }]),
    ]);
    expect(dup.complete === false && dup.reason).toBe('invalid_math');
  });

  it('rejects non-positive planned portions and invalid yield', () => {
    const zeroQty = explodeProduction([
      recipe('r1', 0, [{ ingredientId: 'a', quantity: 1 }]),
    ]);
    expect(zeroQty.complete === false && zeroQty.reason).toBe('invalid_math');

    const badYield = explodeProduction([
      recipe('r1', 1, [{ ingredientId: 'a', quantity: 1 }], { yieldPercentage: 0 }),
    ]);
    expect(badYield.complete === false && badYield.reason).toBe('invalid_math');
  });

  it('rejects an over-domain total as overflow rather than clamping', () => {
    const result = explodeProduction([
      recipe('r1', 100000, [
        { ingredientId: 'a', quantity: NUMERIC_12_2_MAX },
      ]),
    ]);
    expect(result.complete === false && result.reason).toBe('overflow');
  });
});

describe('shortfallVsStock (advisory, never a reservation)', () => {
  const reqs = [
    { ingredientId: 'flour', quantityCanonical: 500 },
    { ingredientId: 'sugar', quantityCanonical: 200 },
    { ingredientId: 'salt', quantityCanonical: 10 },
  ];

  it('computes max(0, needed − onHand) per ingredient', () => {
    const onHand = new Map([
      ['flour', 200], // short by 300
      ['sugar', 200], // exact → 0
      // salt missing → onHand 0 → short by 10
    ]);
    const result = shortfallVsStock(reqs, onHand);
    expect(result).toEqual([
      { ingredientId: 'flour', neededCanonical: 500, onHandCanonical: 200, shortfallCanonical: 300 },
      { ingredientId: 'sugar', neededCanonical: 200, onHandCanonical: 200, shortfallCanonical: 0 },
      { ingredientId: 'salt', neededCanonical: 10, onHandCanonical: 0, shortfallCanonical: 10 },
    ]);
  });

  it('never reports a negative shortfall when overstocked', () => {
    const result = shortfallVsStock(
      [{ ingredientId: 'flour', quantityCanonical: 100 }],
      new Map([['flour', 1000]]),
    );
    expect(result[0]?.shortfallCanonical).toBe(0);
  });
});
