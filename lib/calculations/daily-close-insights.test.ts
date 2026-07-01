import { describe, expect, it } from 'vitest';
import {
  buildDailyCloseInsights,
  type DailyCloseInsightsInput,
  type DailyCloseLineInput,
} from './daily-close-insights';

/** A costed sold line. Net is the whole-line net (units × unit net). */
function line(over: Partial<DailyCloseLineInput> = {}): DailyCloseLineInput {
  return {
    kind: 'recipe',
    id: 'r1',
    name: 'Item',
    unitsSold: 1,
    netCents: 1000,
    unitCostCents: 300,
    ...over,
  };
}

function input(over: Partial<DailyCloseInsightsInput> = {}): DailyCloseInsightsInput {
  return {
    saleDate: '2026-06-15',
    grossCents: 1230,
    netCents: 1000,
    taxCents: 230,
    lines: [line()],
    comparableGrossCents: [],
    ...over,
  };
}

describe('buildDailyCloseInsights', () => {
  it('sums food cost across costed lines and computes food-cost % over net', () => {
    const result = buildDailyCloseInsights(
      input({
        netCents: 2000,
        grossCents: 2460,
        lines: [
          line({ id: 'a', name: 'Burger', unitsSold: 4, netCents: 1200, unitCostCents: 300 }),
          line({ id: 'b', name: 'Fries', unitsSold: 2, netCents: 800, unitCostCents: 100 }),
        ],
      }),
    );

    // 4×300 + 2×100 = 1400 cents food cost; 1400 / 2000 net = 70%.
    expect(result.estimatedFoodCostCents).toBe(1400);
    expect(result.foodCostPercent).toBe(70);
    expect(result.costComplete).toBe(true);
    expect(result.unitsSold).toBe(6);
    expect(result.itemCount).toBe(2);
  });

  it('never fabricates cost: an un-costed line is set aside and flips costComplete', () => {
    const result = buildDailyCloseInsights(
      input({
        netCents: 2000,
        lines: [
          line({ id: 'a', name: 'Burger', unitsSold: 3, netCents: 1200, unitCostCents: 300 }),
          line({ id: 'b', name: 'Mystery', unitsSold: 5, netCents: 800, unitCostCents: null }),
        ],
      }),
    );

    // Only the costed line contributes; the mystery line is listed, not guessed at.
    expect(result.estimatedFoodCostCents).toBe(900);
    expect(result.costComplete).toBe(false);
    expect(result.missingCostItems).toEqual([
      { kind: 'recipe', id: 'b', name: 'Mystery', unitsSold: 5 },
    ]);
  });

  it('returns null food cost/percent when no line has a cost', () => {
    const result = buildDailyCloseInsights(
      input({ lines: [line({ unitCostCents: null }), line({ id: 'r2', unitCostCents: null })] }),
    );
    expect(result.estimatedFoodCostCents).toBeNull();
    expect(result.foodCostPercent).toBeNull();
    expect(result.costComplete).toBe(false);
  });

  it('treats a non-finite cost as un-costed (NaN/Infinity are never trusted)', () => {
    const result = buildDailyCloseInsights(
      input({
        lines: [
          line({ id: 'a', unitCostCents: Number.NaN }),
          line({ id: 'b', unitCostCents: Number.POSITIVE_INFINITY }),
        ],
      }),
    );
    expect(result.estimatedFoodCostCents).toBeNull();
    expect(result.missingCostItems.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('ranks top sellers by units then net, respecting the limit', () => {
    const result = buildDailyCloseInsights(
      input({
        topSellersLimit: 2,
        lines: [
          line({ id: 'a', name: 'A', unitsSold: 2, netCents: 500 }),
          line({ id: 'b', name: 'B', unitsSold: 9, netCents: 900 }),
          line({ id: 'c', name: 'C', unitsSold: 9, netCents: 1500 }),
        ],
      }),
    );
    // 9-unit C (higher net) before 9-unit B; the 2-unit A drops off the limit-2 list.
    expect(result.topSellers.map((s) => s.id)).toEqual(['c', 'b']);
  });

  it('flags costed sellers below the target margin, worst first', () => {
    const result = buildDailyCloseInsights(
      input({
        targetMarginPercent: 65,
        lines: [
          // 300 cost on 1000 net → 70% margin (above target) — not flagged.
          line({ id: 'good', name: 'Good', unitsSold: 1, netCents: 1000, unitCostCents: 300 }),
          // 600 cost on 1000 net → 40% margin — flagged.
          line({ id: 'thin', name: 'Thin', unitsSold: 1, netCents: 1000, unitCostCents: 600 }),
          // 800 cost on 1000 net → 20% margin — flagged, and worse, so first.
          line({ id: 'worst', name: 'Worst', unitsSold: 1, netCents: 1000, unitCostCents: 800 }),
        ],
      }),
    );
    expect(result.lowMarginSellers.map((s) => s.id)).toEqual(['worst', 'thin']);
    expect(result.lowMarginSellers[0]!.marginPercent).toBe(20);
    expect(result.lowMarginSellers[0]!.contributionMarginCents).toBe(200);
  });

  it('reports variance vs comparable days once enough history exists', () => {
    const result = buildDailyCloseInsights(
      input({
        grossCents: 2000,
        comparableGrossCents: [1000, 1000, 1000],
      }),
    );
    expect(result.variance).toEqual({
      baselineAvgGrossCents: 1000,
      sampleSize: 3,
      changePercent: 100,
      direction: 'up',
      unusual: true,
    });
  });

  it('withholds variance below the minimum history and marks small moves as not unusual', () => {
    const thin = buildDailyCloseInsights(
      input({ grossCents: 2000, comparableGrossCents: [1000, 1000] }),
    );
    expect(thin.variance).toBeNull();

    const steady = buildDailyCloseInsights(
      input({
        grossCents: 1050,
        comparableGrossCents: [1000, 1000, 1000],
        unusualVariancePercent: 30,
      }),
    );
    expect(steady.variance?.changePercent).toBe(5);
    expect(steady.variance?.unusual).toBe(false);
    expect(steady.variance?.direction).toBe('up');
  });

  it('handles an empty close without dividing by zero', () => {
    const result = buildDailyCloseInsights(
      input({ grossCents: 0, netCents: 0, taxCents: 0, lines: [] }),
    );
    expect(result.estimatedFoodCostCents).toBeNull();
    expect(result.foodCostPercent).toBeNull();
    expect(result.topSellers).toEqual([]);
    expect(result.lowMarginSellers).toEqual([]);
    expect(result.unitsSold).toBe(0);
  });
});
