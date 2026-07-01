import { describe, expect, it } from 'vitest';
import {
  parseDailyCloseSummaryResponse,
  dailyCloseSummarySchema,
  buildDailyCloseSummaryFacts,
  DailyCloseSummaryError,
} from '@/lib/ai/daily-close-summary';
import type { DailyCloseInsights } from '@/lib/calculations/daily-close-insights';

/**
 * Pure tests for the daily-close summary provider boundary (Sprint 6): the untrusted-input
 * Zod schema, the parse function, and the pure facts builder. No network / provider.
 */

function validSummary() {
  return {
    headline: 'Strong Saturday — sales up on your usual',
    summary:
      'You took more than your typical Saturday and food cost stayed on target. Burger was ' +
      'your standout seller. Keep an eye on the thin-margin side dish.',
    highlights: ['Top seller: Burger (24)', 'Sales up 30% vs comparable Saturdays'],
    riskLevel: 'low' as const,
  };
}

function insights(over: Partial<DailyCloseInsights> = {}): DailyCloseInsights {
  return {
    saleDate: '2026-06-27',
    grossSalesCents: 2460,
    netSalesCents: 2000,
    taxCents: 460,
    itemCount: 2,
    unitsSold: 6,
    estimatedFoodCostCents: 1400,
    foodCostPercent: 70,
    costComplete: true,
    targetMarginPercent: 65,
    topSellers: [
      { kind: 'recipe', id: 'a', name: 'Burger', unitsSold: 4, netCents: 1200 },
      { kind: 'recipe', id: 'b', name: 'Fries', unitsSold: 2, netCents: 800 },
    ],
    lowMarginSellers: [
      { kind: 'recipe', id: 'b', name: 'Fries', unitsSold: 2, marginPercent: 40, contributionMarginCents: 160 },
    ],
    missingCostItems: [],
    variance: { baselineAvgGrossCents: 1900, sampleSize: 4, changePercent: 29.5, direction: 'up', unusual: false },
    ...over,
  };
}

describe('dailyCloseSummarySchema (untrusted boundary)', () => {
  it('accepts a well-formed summary', () => {
    expect(dailyCloseSummarySchema.safeParse(validSummary()).success).toBe(true);
  });

  it('defaults highlights to an empty array when omitted', () => {
    const { highlights, ...noHighlights } = validSummary();
    void highlights;
    const parsed = dailyCloseSummarySchema.safeParse(noHighlights);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.highlights).toEqual([]);
  });

  it('rejects an invalid riskLevel', () => {
    expect(
      dailyCloseSummarySchema.safeParse({ ...validSummary(), riskLevel: 'meltdown' }).success,
    ).toBe(false);
  });

  it('rejects too many highlights (UI/memory guard)', () => {
    const bad = { ...validSummary(), highlights: ['a', 'b', 'c', 'd', 'e'] };
    expect(dailyCloseSummarySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an over-length summary', () => {
    const bad = { ...validSummary(), summary: 'x'.repeat(701) };
    expect(dailyCloseSummarySchema.safeParse(bad).success).toBe(false);
  });
});

describe('parseDailyCloseSummaryResponse', () => {
  it('parses valid JSON', () => {
    const out = parseDailyCloseSummaryResponse(JSON.stringify(validSummary()));
    expect(out.riskLevel).toBe('low');
    expect(out.highlights).toHaveLength(2);
  });

  it('throws on non-JSON', () => {
    expect(() => parseDailyCloseSummaryResponse('not json')).toThrow(DailyCloseSummaryError);
  });

  it('throws on schema violation', () => {
    expect(() => parseDailyCloseSummaryResponse('{"headline":"x"}')).toThrow(
      DailyCloseSummaryError,
    );
  });
});

describe('buildDailyCloseSummaryFacts', () => {
  it('passes through the computed figures without deriving anything', () => {
    const facts = buildDailyCloseSummaryFacts(insights(), 'EUR');
    expect(facts.currency).toBe('EUR');
    expect(facts.grossSalesCents).toBe(2460);
    expect(facts.foodCostPercent).toBe(70);
    expect(facts.costComplete).toBe(true);
    expect(facts.topSellers).toEqual([
      { name: 'Burger', unitsSold: 4 },
      { name: 'Fries', unitsSold: 2 },
    ]);
    expect(facts.lowMarginSellers).toEqual([{ name: 'Fries', marginPercent: 40 }]);
    expect(facts.variance).toEqual({
      changePercent: 29.5,
      direction: 'up',
      sampleSize: 4,
      unusual: false,
    });
  });

  it('carries missing-cost item names and a null food cost through honestly', () => {
    const facts = buildDailyCloseSummaryFacts(
      insights({
        estimatedFoodCostCents: null,
        foodCostPercent: null,
        costComplete: false,
        missingCostItems: [{ kind: 'recipe', id: 'z', name: 'Mystery', unitsSold: 3 }],
      }),
      'EUR',
    );
    expect(facts.estimatedFoodCostCents).toBeNull();
    expect(facts.foodCostPercent).toBeNull();
    expect(facts.costComplete).toBe(false);
    expect(facts.missingCostItemNames).toEqual(['Mystery']);
  });
});
