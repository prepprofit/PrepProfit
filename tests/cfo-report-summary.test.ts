import { describe, expect, it } from 'vitest';
import {
  parseCfoReportResponse,
  cfoReportSummarySchema,
  buildCfoReportFacts,
  CfoReportError,
} from '@/lib/ai/cfo-report';
import type { CfoReport } from '@/lib/calculations/cfo-report';

/**
 * Pure tests for the CFO report provider boundary (Sprint 8): the untrusted-input Zod schema,
 * the parse function, and the pure facts builder. No network / provider.
 */

function validSummary() {
  return {
    headline: 'Solid week — revenue up, watch your rising cheese cost',
    summary:
      'Revenue rose 12% on last week and food cost held near target. Two dishes are below ' +
      'your 65% goal and worth a small price bump. A supplier raised butter 20%.',
    highlights: ['Reprice Soup to €9.00', 'Butter up 20% — review menu cost'],
    riskLevel: 'medium' as const,
  };
}

function report(over: Partial<CfoReport> = {}): CfoReport {
  return {
    weekFrom: '2026-06-24',
    weekTo: '2026-06-30',
    targetMarginPercent: 65,
    revenue: {
      thisWeekGrossCents: 12_000,
      priorWeekGrossCents: 10_000,
      thisWeekNetCents: 10_000,
      priorWeekNetCents: 8_500,
      changePercent: 20,
      direction: 'up',
    },
    foodCost: {
      thisWeekPercent: 30,
      priorWeekPercent: 35,
      changePoints: -5,
      direction: 'down',
      thisWeekComplete: true,
    },
    marginLeaks: [
      {
        fingerprint: 'fp1',
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
      },
    ],
    repriceCandidates: [
      {
        entityType: 'recipe',
        entityId: 'r1',
        entityName: 'Soup',
        currentMarginPercent: 40,
        targetMarginPercent: 65,
        currentCostCents: 300,
        suggestedPriceCents: 900,
      },
    ],
    supplierPriceChanges: [
      {
        ingredientId: 'i1',
        name: 'Butter',
        fromCents: 1_000,
        toCents: 1_200,
        changePercent: 20,
        direction: 'up',
      },
    ],
    lowStock: [
      {
        ingredientId: 'i2',
        name: 'Onion',
        dimension: 'weight',
        onHandCanonical: 100,
        thresholdCanonical: 1_000,
      },
    ],
    confidence: [{ code: 'UNPRICED_INGREDIENTS', count: 2 }],
    hasData: true,
    ...over,
  };
}

describe('cfoReportSummarySchema (untrusted boundary)', () => {
  it('accepts a well-formed summary', () => {
    expect(cfoReportSummarySchema.safeParse(validSummary()).success).toBe(true);
  });

  it('defaults highlights to an empty array when omitted', () => {
    const { highlights, ...noHighlights } = validSummary();
    void highlights;
    const parsed = cfoReportSummarySchema.safeParse(noHighlights);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.highlights).toEqual([]);
  });

  it('rejects an invalid riskLevel', () => {
    expect(
      cfoReportSummarySchema.safeParse({ ...validSummary(), riskLevel: 'apocalypse' }).success,
    ).toBe(false);
  });

  it('rejects too many highlights (UI/memory guard)', () => {
    const bad = { ...validSummary(), highlights: ['a', 'b', 'c', 'd', 'e', 'f'] };
    expect(cfoReportSummarySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an over-length summary', () => {
    const bad = { ...validSummary(), summary: 'x'.repeat(1_001) };
    expect(cfoReportSummarySchema.safeParse(bad).success).toBe(false);
  });
});

describe('parseCfoReportResponse', () => {
  it('parses valid JSON', () => {
    const out = parseCfoReportResponse(JSON.stringify(validSummary()));
    expect(out.riskLevel).toBe('medium');
    expect(out.highlights).toHaveLength(2);
  });

  it('throws on non-JSON', () => {
    expect(() => parseCfoReportResponse('not json')).toThrow(CfoReportError);
  });

  it('throws on schema violation', () => {
    expect(() => parseCfoReportResponse('{"headline":"x"}')).toThrow(CfoReportError);
  });
});

describe('buildCfoReportFacts', () => {
  it('passes through the computed figures + currency without deriving anything', () => {
    const facts = buildCfoReportFacts(report(), 'EUR');
    expect(facts.currency).toBe('EUR');
    expect(facts.revenue.changePercent).toBe(20);
    expect(facts.foodCost.thisWeekPercent).toBe(30);
    expect(facts.foodCost.changePoints).toBe(-5);
    expect(facts.repriceCandidates).toEqual([
      { name: 'Soup', marginPercent: 40, currentCostCents: 300, suggestedPriceCents: 900 },
    ]);
    expect(facts.supplierPriceChanges[0]).toMatchObject({
      name: 'Butter',
      fromCents: 1_000,
      toCents: 1_200,
      changePercent: 20,
      direction: 'up',
    });
    expect(facts.lowStock).toEqual([
      { name: 'Onion', dimension: 'weight', onHand: 100, threshold: 1_000 },
    ]);
    expect(facts.confidence).toEqual([{ code: 'UNPRICED_INGREDIENTS', count: 2 }]);
  });

  it('carries a null food-cost trend through honestly', () => {
    const facts = buildCfoReportFacts(
      report({
        foodCost: {
          thisWeekPercent: null,
          priorWeekPercent: 35,
          changePoints: null,
          direction: 'flat',
          thisWeekComplete: false,
        },
      }),
      'EUR',
    );
    expect(facts.foodCost.thisWeekPercent).toBeNull();
    expect(facts.foodCost.changePoints).toBeNull();
    expect(facts.foodCost.thisWeekComplete).toBe(false);
  });
});
