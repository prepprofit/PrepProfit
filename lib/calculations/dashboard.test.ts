import { describe, expect, it } from 'vitest';
import { dashboardSummary, type DashboardRecipeInput } from './dashboard';

/** A recipe whose ingredient cost per portion is 117c (the recipeCost fixture). */
function recipe(
  id: string,
  name: string,
  sellingPriceCents: number | null,
): DashboardRecipeInput {
  return {
    id,
    name,
    sellingPriceCents,
    cost: {
      yieldPortions: 10,
      yieldPercentage: 100,
      laborCostCents: 0,
      energyCostCents: 0,
      packagingCostCents: 0,
      lines: [
        { dimension: 'weight', priceCents: 120, quantity: 2000 }, // 240
        { dimension: 'weight', priceCents: 800, quantity: 500 }, // 400
        { dimension: 'volume', priceCents: 150, quantity: 1000 }, // 150
        { dimension: 'volume', priceCents: 800, quantity: 250 }, // 200
        { dimension: 'count', priceCents: 30, quantity: 6 }, // 180
      ], // total 1170 → 117/portion, ingredient cost/portion = 117
    },
  };
}

describe('dashboardSummary', () => {
  it('counts all recipes but only prices the ones with a selling price', () => {
    const s = dashboardSummary([
      recipe('a', 'Priced', 390),
      recipe('b', 'Unpriced', null),
      recipe('c', 'Zero price', 0),
    ]);
    expect(s.activeRecipes).toBe(3);
    expect(s.pricedRecipes).toBe(1);
  });

  it('averages margin and food cost across priced recipes only', () => {
    // price 390 → margin 70%, food cost 117/390 = 30%
    // price 234 → margin 50%, food cost 117/234 = 50%
    const s = dashboardSummary([
      recipe('a', 'High', 390),
      recipe('b', 'Low', 234),
      recipe('c', 'Unpriced', null),
    ]);
    expect(s.avgMarginPercent).toBe(60); // (70 + 50) / 2
    expect(s.avgFoodCostPercent).toBe(40); // (30 + 50) / 2
  });

  it('returns null averages when nothing is priced', () => {
    const s = dashboardSummary([recipe('a', 'A', null), recipe('b', 'B', null)]);
    expect(s.avgMarginPercent).toBeNull();
    expect(s.avgFoodCostPercent).toBeNull();
    expect(s.topByMargin).toEqual([]);
  });

  it('ranks top recipes by margin and caps the list', () => {
    const s = dashboardSummary(
      [
        recipe('a', 'Best', 585), // margin 80%
        recipe('b', 'Mid', 390), // margin 70%
        recipe('c', 'Worst', 234), // margin 50%
      ],
      2,
    );
    expect(s.topByMargin.map((r) => r.name)).toEqual(['Best', 'Mid']);
    expect(s.topByMargin[0]?.marginPercent).toBe(80);
  });

  it('handles an empty workspace', () => {
    const s = dashboardSummary([]);
    expect(s).toEqual({
      activeRecipes: 0,
      pricedRecipes: 0,
      avgMarginPercent: null,
      avgFoodCostPercent: null,
      topByMargin: [],
    });
  });
});
