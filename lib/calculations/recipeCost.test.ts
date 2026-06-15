import { describe, expect, it } from 'vitest';
import {
  lineCostCents,
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
