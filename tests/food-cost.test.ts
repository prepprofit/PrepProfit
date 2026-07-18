import { describe, expect, it } from 'vitest';
import {
  foodCostBps,
  portionCostCents,
  portionOptionCostCents,
  profitCents,
  suggestedPriceCents,
} from '@/lib/calculations/foodCost';

/**
 * Food cost calculator (Recipes 2.0 Fase 5, §7.3): both calculator directions
 * plus the money edges CLAUDE.md demands — zero, negative, large, rounding,
 * NaN and Infinity.
 */

describe('foodCostBps', () => {
  it('computes the classic case', () => {
    // cost 300 on price 1000 → 30.00%
    expect(foodCostBps(300, 1000)).toBe(3000);
  });

  it('rounds to the nearest basis point', () => {
    expect(foodCostBps(333, 1000)).toBe(3330);
    expect(foodCostBps(1, 3)).toBe(3333);
    expect(foodCostBps(2, 3)).toBe(6667);
  });

  it('cost above price goes past 100%', () => {
    expect(foodCostBps(1500, 1000)).toBe(15000);
  });

  it('zero cost is honestly 0 bps; zero price is null, never Infinity', () => {
    expect(foodCostBps(0, 1000)).toBe(0);
    expect(foodCostBps(300, 0)).toBeNull();
  });

  it('null/undefined/negative/NaN/Infinity/overflow → null', () => {
    expect(foodCostBps(null, 1000)).toBeNull();
    expect(foodCostBps(300, undefined)).toBeNull();
    expect(foodCostBps(-1, 1000)).toBeNull();
    expect(foodCostBps(300, -5)).toBeNull();
    expect(foodCostBps(Number.NaN, 1000)).toBeNull();
    expect(foodCostBps(300, Number.POSITIVE_INFINITY)).toBeNull();
    expect(foodCostBps(200_000_000, 1000)).toBeNull();
  });
});

describe('profitCents', () => {
  it('is price minus cost, and may go negative', () => {
    expect(profitCents(300, 1000)).toBe(700);
    expect(profitCents(1200, 1000)).toBe(-200);
    expect(profitCents(0, 0)).toBe(0);
  });

  it('invalid inputs → null', () => {
    expect(profitCents(null, 1000)).toBeNull();
    expect(profitCents(300, null)).toBeNull();
    expect(profitCents(Number.NaN, 1000)).toBeNull();
    expect(profitCents(300, Number.NEGATIVE_INFINITY)).toBeNull();
    expect(profitCents(-10, 1000)).toBeNull();
  });
});

describe('suggestedPriceCents (reverse direction)', () => {
  it('suggests the price hitting the target food cost', () => {
    // cost 300 at target 30% → 1000
    expect(suggestedPriceCents(300, 3000)).toBe(1000);
    // cost 250 at target 25% → 1000
    expect(suggestedPriceCents(250, 2500)).toBe(1000);
  });

  it('round-trips with foodCostBps within rounding tolerance', () => {
    const price = suggestedPriceCents(333, 2800)!;
    const bps = foodCostBps(333, price)!;
    expect(Math.abs(bps - 2800)).toBeLessThanOrEqual(5);
  });

  it('a 100% target sells at cost', () => {
    expect(suggestedPriceCents(750, 10_000)).toBe(750);
  });

  it('clamps to the money ceiling instead of overflowing', () => {
    expect(suggestedPriceCents(100_000_000, 1)).toBe(100_000_000);
  });

  it('zero cost suggests a zero price (0 at any target)', () => {
    expect(suggestedPriceCents(0, 3000)).toBe(0);
  });

  it('invalid cost or out-of-range target → null', () => {
    expect(suggestedPriceCents(null, 3000)).toBeNull();
    expect(suggestedPriceCents(300, null)).toBeNull();
    expect(suggestedPriceCents(300, 0)).toBeNull();
    expect(suggestedPriceCents(300, 10_001)).toBeNull();
    expect(suggestedPriceCents(300, -100)).toBeNull();
    expect(suggestedPriceCents(Number.NaN, 3000)).toBeNull();
    expect(suggestedPriceCents(300, Number.NaN)).toBeNull();
    expect(suggestedPriceCents(Number.POSITIVE_INFINITY, 3000)).toBeNull();
  });
});

describe('portionCostCents', () => {
  it('is the portion fraction of the batch total', () => {
    // 250 g portion of a 1000 g batch costing 800 → 200
    expect(portionCostCents(800, 250, 1000)).toBe(200);
  });

  it('a portion larger than the batch costs more than the batch', () => {
    expect(portionCostCents(800, 2000, 1000)).toBe(1600);
  });

  it('rounds once', () => {
    expect(portionCostCents(1000, 1, 3)).toBe(333);
    expect(portionCostCents(1000, 2, 3)).toBe(667);
  });

  it('missing/zero/negative/non-finite inputs → null', () => {
    expect(portionCostCents(null, 1, 10)).toBeNull();
    expect(portionCostCents(800, null, 10)).toBeNull();
    expect(portionCostCents(800, 1, null)).toBeNull();
    expect(portionCostCents(800, 0, 10)).toBeNull();
    expect(portionCostCents(800, 1, 0)).toBeNull();
    expect(portionCostCents(-1, 1, 10)).toBeNull();
    expect(portionCostCents(Number.NaN, 1, 10)).toBeNull();
    expect(portionCostCents(800, Number.POSITIVE_INFINITY, 10)).toBeNull();
    expect(portionCostCents(800, 1, Number.NaN)).toBeNull();
  });

  it('zero-cost batch portions at zero', () => {
    expect(portionCostCents(0, 1, 10)).toBe(0);
  });
});

describe('portionOptionCostCents', () => {
  const base = {
    totalCostCents: 1200,
    yieldQuantity: 3,
    yieldUnit: 'qt',
    yieldPortions: 12,
  };

  it('matches the yield unit → fraction over yieldQuantity', () => {
    expect(
      portionOptionCostCents({ ...base, portionQuantity: 1, portionUnit: 'qt' }),
    ).toBe(400);
    // Case/space-insensitive match, no conversion.
    expect(
      portionOptionCostCents({ ...base, portionQuantity: 1, portionUnit: ' QT ' }),
    ).toBe(400);
  });

  it('serving unit → fraction over yieldPortions', () => {
    expect(
      portionOptionCostCents({
        ...base,
        portionQuantity: 1,
        portionUnit: 'serving',
      }),
    ).toBe(100);
    expect(
      portionOptionCostCents({
        ...base,
        portionQuantity: 2,
        portionUnit: 'servings',
      }),
    ).toBe(200);
  });

  it('unit mismatch is honestly incomputable — null, never a guess', () => {
    expect(
      portionOptionCostCents({ ...base, portionQuantity: 100, portionUnit: 'g' }),
    ).toBeNull();
  });

  it('missing/invalid yields → null', () => {
    expect(
      portionOptionCostCents({
        ...base,
        yieldQuantity: null,
        portionQuantity: 1,
        portionUnit: 'qt',
      }),
    ).toBeNull();
    expect(
      portionOptionCostCents({
        ...base,
        yieldPortions: 0,
        portionQuantity: 1,
        portionUnit: 'serving',
      }),
    ).toBeNull();
    expect(
      portionOptionCostCents({
        ...base,
        totalCostCents: Number.NaN,
        portionQuantity: 1,
        portionUnit: 'qt',
      }),
    ).toBeNull();
  });
});
