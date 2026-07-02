import { describe, expect, it } from 'vitest';
import {
  buildCfoReport,
  type CfoReportInput,
  type CfoWeeklyTotals,
} from '@/lib/calculations/cfo-report';
import type { ProfitLeakFinding } from '@/lib/calculations/profit-leaks';

/**
 * Weekly CFO Report pure-calc tests (Sprint 8). Locks the honesty contract: trends are null
 * (with a confidence note) when a baseline is missing, food cost is over net, leaks/reprice
 * come straight off the detector, and nothing is fabricated.
 */

function week(overrides: Partial<CfoWeeklyTotals> = {}): CfoWeeklyTotals {
  return {
    grossCents: 0,
    netCents: 0,
    foodCostCents: null,
    costComplete: true,
    closeCount: 0,
    ...overrides,
  };
}

function belowTargetFinding(
  overrides: Partial<ProfitLeakFinding> = {},
): ProfitLeakFinding {
  return {
    fingerprint: 'fp',
    type: 'RECIPE_BELOW_TARGET_MARGIN',
    severity: 'warning',
    entityType: 'recipe',
    entityId: 'r1',
    entityName: 'Soup',
    affectedEntityIds: [],
    currentMarginPercent: 40,
    targetMarginPercent: 65,
    currentCostCents: 300,
    pendingCostCents: null,
    suggestedPriceCents: 900,
    reasonCode: 'BELOW_TARGET_MARGIN',
    ...overrides,
  };
}

function baseInput(overrides: Partial<CfoReportInput> = {}): CfoReportInput {
  return {
    weekFrom: '2026-06-24',
    weekTo: '2026-06-30',
    thisWeek: week(),
    priorWeek: week(),
    marginLeaks: [],
    supplierPriceChanges: [],
    lowStock: [],
    unpricedIngredientCount: 0,
    incompleteMenuCount: 0,
    ...overrides,
  };
}

describe('buildCfoReport', () => {
  it('computes the revenue trend as a gross % vs the prior week', () => {
    const report = buildCfoReport(
      baseInput({
        thisWeek: week({ grossCents: 12_000, netCents: 10_000, closeCount: 6 }),
        priorWeek: week({ grossCents: 10_000, netCents: 8_500, closeCount: 6 }),
      }),
    );
    expect(report.revenue.changePercent).toBe(20);
    expect(report.revenue.direction).toBe('up');
    expect(report.hasData).toBe(true);
  });

  it('reports NO prior-week baseline (null trend) when the prior week had no sales', () => {
    const report = buildCfoReport(
      baseInput({
        thisWeek: week({ grossCents: 12_000, netCents: 10_000, closeCount: 6 }),
        priorWeek: week({ closeCount: 0 }),
      }),
    );
    expect(report.revenue.changePercent).toBeNull();
    expect(report.revenue.direction).toBe('flat');
    expect(report.confidence.map((c) => c.code)).toContain('NO_PRIOR_WEEK_BASELINE');
  });

  it('computes food-cost % over NET and the trend as percentage points', () => {
    const report = buildCfoReport(
      baseInput({
        // 3000/10000 = 30% this week, 2400/8000 = 30% prior → +0.0 pts
        thisWeek: week({ grossCents: 11_000, netCents: 10_000, foodCostCents: 3_000, closeCount: 6 }),
        priorWeek: week({ grossCents: 9_000, netCents: 8_000, foodCostCents: 2_800, closeCount: 6 }),
      }),
    );
    expect(report.foodCost.thisWeekPercent).toBe(30);
    expect(report.foodCost.priorWeekPercent).toBe(35);
    expect(report.foodCost.changePoints).toBe(-5);
    expect(report.foodCost.direction).toBe('down');
  });

  it('flags a partial food cost and never computes a % without a costed line', () => {
    const report = buildCfoReport(
      baseInput({
        thisWeek: week({
          grossCents: 11_000,
          netCents: 10_000,
          foodCostCents: null,
          costComplete: false,
          closeCount: 6,
        }),
        priorWeek: week({ grossCents: 9_000, netCents: 8_000, foodCostCents: 2_800, closeCount: 6 }),
      }),
    );
    expect(report.foodCost.thisWeekPercent).toBeNull();
    expect(report.foodCost.changePoints).toBeNull();
    expect(report.foodCost.thisWeekComplete).toBe(false);
    expect(report.confidence.map((c) => c.code)).toContain('PARTIAL_FOOD_COST');
  });

  it('derives reprice candidates only from below-target sold-item findings', () => {
    const report = buildCfoReport(
      baseInput({
        marginLeaks: [
          belowTargetFinding({ entityId: 'r1', entityName: 'Soup', currentMarginPercent: 40 }),
          belowTargetFinding({
            type: 'MENU_BELOW_TARGET_MARGIN',
            entityType: 'menu',
            entityId: 'm1',
            entityName: 'Combo',
            currentMarginPercent: 55,
            currentCostCents: 500,
            suggestedPriceCents: 1_400,
          }),
          // An unpriced finding must NOT become a reprice candidate (margin is untrue).
          belowTargetFinding({
            type: 'UNPRICED_INGREDIENT_IN_ACTIVE_RECIPE',
            entityType: 'ingredient',
            entityId: 'i1',
            entityName: 'Flour',
            currentMarginPercent: null,
            currentCostCents: null,
            suggestedPriceCents: null,
          }),
        ],
      }),
    );
    expect(report.repriceCandidates.map((c) => c.entityId)).toEqual(['r1', 'm1']);
    expect(report.repriceCandidates[0]?.entityType).toBe('recipe');
    expect(report.repriceCandidates[1]?.entityType).toBe('menu');
  });

  it('ranks supplier price changes by absolute move and drops no-op equals', () => {
    const report = buildCfoReport(
      baseInput({
        supplierPriceChanges: [
          { ingredientId: 'a', name: 'Butter', fromCents: 1_000, toCents: 1_100 }, // +100
          { ingredientId: 'b', name: 'Cream', fromCents: 800, toCents: 500 }, // -300
          { ingredientId: 'c', name: 'Salt', fromCents: 200, toCents: 200 }, // no-op → dropped
        ],
      }),
    );
    expect(report.supplierPriceChanges.map((c) => c.ingredientId)).toEqual(['b', 'a']);
    expect(report.supplierPriceChanges[0]?.direction).toBe('down');
    expect(report.supplierPriceChanges[0]?.changePercent).toBe(-37.5);
    expect(report.supplierPriceChanges[1]?.changePercent).toBe(10);
  });

  it('surfaces low stock most-depleted-first and carries data-gap confidence notes', () => {
    const report = buildCfoReport(
      baseInput({
        lowStock: [
          { ingredientId: 'x', name: 'Onion', dimension: 'weight', onHandCanonical: 900, thresholdCanonical: 1_000 }, // 0.9
          { ingredientId: 'y', name: 'Garlic', dimension: 'weight', onHandCanonical: 100, thresholdCanonical: 1_000 }, // 0.1
        ],
        unpricedIngredientCount: 2,
        incompleteMenuCount: 1,
      }),
    );
    expect(report.lowStock.map((l) => l.ingredientId)).toEqual(['y', 'x']);
    const codes = report.confidence.map((c) => c.code);
    expect(codes).toContain('UNPRICED_INGREDIENTS');
    expect(codes).toContain('INCOMPLETE_MENUS');
    expect(report.confidence.find((c) => c.code === 'UNPRICED_INGREDIENTS')?.count).toBe(2);
  });

  it('reports NO_SALES_THIS_WEEK and hasData=false on an empty week', () => {
    const report = buildCfoReport(baseInput());
    expect(report.hasData).toBe(false);
    expect(report.confidence.map((c) => c.code)).toContain('NO_SALES_THIS_WEEK');
  });

  it('respects the surfacing limits', () => {
    const leaks = Array.from({ length: 12 }, (_, i) =>
      belowTargetFinding({ entityId: `r${i}`, entityName: `Item ${i}` }),
    );
    const report = buildCfoReport(baseInput({ marginLeaks: leaks, topLeaksLimit: 3, topRepriceLimit: 2 }));
    expect(report.marginLeaks).toHaveLength(3);
    expect(report.repriceCandidates).toHaveLength(2);
  });
});
