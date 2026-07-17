import { describe, expect, it } from 'vitest';
import {
  costPerKgCents,
  lineCostCents,
  presetCostCents,
  recipeCost,
  type RecipeCostInput,
  type RecipeCostLine,
} from './recipeCost';

const FIVE_INGREDIENTS: RecipeCostLine[] = [
  { dimension: 'weight', priceCents: 120, quantity: 2000 }, // flour: 240
  { dimension: 'weight', priceCents: 800, quantity: 500 }, // butter: 400
  { dimension: 'volume', priceCents: 150, quantity: 1000 }, // milk: 150
  { dimension: 'volume', priceCents: 800, quantity: 250 }, // oil: 200
  { dimension: 'count', priceCents: 30, quantity: 6 }, // eggs: 180
];

describe('lineCostCents', () => {
  it('prices weight per kg, volume per litre, count per piece', () => {
    expect(lineCostCents({ dimension: 'weight', priceCents: 120, quantity: 2000 })).toBe(240);
    expect(lineCostCents({ dimension: 'volume', priceCents: 150, quantity: 1000 })).toBe(150);
    expect(lineCostCents({ dimension: 'count', priceCents: 30, quantity: 6 })).toBe(180);
  });

  it('applies prep yield as required-purchase loss without double counting', () => {
    // 200 g edible @ 300c/kg = 60c; 80% yield → purchase 250 g → 75c.
    expect(
      lineCostCents({
        dimension: 'weight',
        priceCents: 300,
        quantity: 200,
        prepYieldBps: 8000,
      }),
    ).toBe(75);
  });

  it('treats absent/full/out-of-range/non-finite yield as no loss', () => {
    const base = { dimension: 'weight' as const, priceCents: 300, quantity: 200 };
    expect(lineCostCents(base)).toBe(60);
    expect(lineCostCents({ ...base, prepYieldBps: 10_000 })).toBe(60);
    expect(lineCostCents({ ...base, prepYieldBps: 0 })).toBe(60);
    expect(lineCostCents({ ...base, prepYieldBps: -5 })).toBe(60);
    expect(lineCostCents({ ...base, prepYieldBps: 20_000 })).toBe(60);
    expect(lineCostCents({ ...base, prepYieldBps: Number.NaN })).toBe(60);
    expect(lineCostCents({ ...base, prepYieldBps: Number.POSITIVE_INFINITY })).toBe(60);
  });
});

describe('recipeCost', () => {
  it('sums a 5-ingredient recipe (acceptance criterion)', () => {
    const input: RecipeCostInput = {
      yieldPortions: 10,
      yieldPercentage: 100,
      laborCostCents: 0,
      energyCostCents: 0,
      packagingCostCents: 0,
      lines: FIVE_INGREDIENTS,
    };
    const cost = recipeCost(input);
    expect(cost.ingredientCostCents).toBe(1170);
    expect(cost.hiddenCostCents).toBe(0);
    expect(cost.totalCostCents).toBe(1170);
    expect(cost.costPerPortionCents).toBe(117);
  });

  it('applies loss adjustment and hidden costs', () => {
    const cost = recipeCost({
      yieldPortions: 10,
      yieldPercentage: 90, // 10% loss → ingredient cost / 0.9
      laborCostCents: 500,
      energyCostCents: 100,
      packagingCostCents: 200,
      lines: FIVE_INGREDIENTS,
    });
    expect(cost.ingredientCostCents).toBe(1300); // 1170 / 0.9
    expect(cost.hiddenCostCents).toBe(800);
    expect(cost.totalCostCents).toBe(2100);
    expect(cost.costPerPortionCents).toBe(210);
  });

  it('rounds sub-cent line costs to integer cents', () => {
    const cost = recipeCost({
      yieldPortions: 1,
      yieldPercentage: 100,
      laborCostCents: 0,
      energyCostCents: 0,
      packagingCostCents: 0,
      lines: [{ dimension: 'weight', priceCents: 333, quantity: 100 }], // 33.3
    });
    expect(cost.ingredientCostCents).toBe(33);
    expect(cost.costPerPortionCents).toBe(33);
  });

  it('handles an empty recipe and guards divide-by-zero', () => {
    const cost = recipeCost({
      yieldPortions: 0,
      yieldPercentage: 0,
      laborCostCents: 0,
      energyCostCents: 0,
      packagingCostCents: 0,
      lines: [],
    });
    expect(cost.ingredientCostCents).toBe(0);
    expect(cost.totalCostCents).toBe(0);
    expect(cost.costPerPortionCents).toBe(0);
  });
});

describe('costPerKgCents', () => {
  it('returns null for missing/zero/negative weight', () => {
    expect(costPerKgCents(1000, null)).toBeNull();
    expect(costPerKgCents(1000, undefined)).toBeNull();
    expect(costPerKgCents(1000, 0)).toBeNull();
    expect(costPerKgCents(1000, -500)).toBeNull();
  });

  it('returns null for non-finite weight or total cost', () => {
    expect(costPerKgCents(1000, Number.NaN)).toBeNull();
    expect(costPerKgCents(1000, Number.POSITIVE_INFINITY)).toBeNull();
    expect(costPerKgCents(Number.NaN, 1000)).toBeNull();
    expect(costPerKgCents(Number.POSITIVE_INFINITY, 1000)).toBeNull();
  });

  it('computes cents per kg with a single final round', () => {
    // 1170c batch over 2340g → 500.0c/kg
    expect(costPerKgCents(1170, 2340)).toBe(500);
    // 1000c over 750g → 1333.33…c/kg → 1333
    expect(costPerKgCents(1000, 750)).toBe(1333);
  });

  it('handles large in-domain values', () => {
    // 100_000_000c over 99_999_999.99g ≈ 1000.00c/kg
    expect(costPerKgCents(100_000_000, 99_999_999.99)).toBe(1000);
  });
});

describe('presetCostCents', () => {
  it('returns null when base/target weight or cost is missing or non-positive', () => {
    expect(presetCostCents(1000, null, 500)).toBeNull();
    expect(presetCostCents(1000, 1000, null)).toBeNull();
    expect(presetCostCents(1000, 0, 500)).toBeNull();
    expect(presetCostCents(1000, 1000, 0)).toBeNull();
    expect(presetCostCents(1000, 1000, -1)).toBeNull();
    expect(presetCostCents(Number.NaN, 1000, 500)).toBeNull();
  });

  it('scales the batch total by the exact factor and rounds once', () => {
    // half the batch weight → half the cost
    expect(presetCostCents(1170, 2340, 1170)).toBe(585);
    // round once, not from a pre-rounded cost/kg:
    // 1000c * 333g / 750g = 444.0 → 444 (cost/kg would lose precision)
    expect(presetCostCents(1000, 750, 333)).toBe(444);
  });
});
