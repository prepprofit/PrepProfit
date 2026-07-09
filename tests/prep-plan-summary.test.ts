import { describe, expect, it } from 'vitest';
import {
  parsePrepPlanSummaryResponse,
  prepPlanSummarySchema,
  buildPrepPlanSummaryFacts,
  PrepPlanSummaryError,
} from '@/lib/ai/prep-plan-summary';
import type { PrepReorderPlan } from '@/lib/calculations/prep-reorder-plan';

/**
 * Pure tests for the prep-plan summary provider boundary (Sprint 7): the untrusted-input
 * Zod schema, the parse function, and the pure MONEY-FREE facts builder. No network/provider.
 */

function validSummary() {
  return {
    headline: 'Busy prep day — reorder flour before service',
    summary:
      'Prep 30 portions of Bread and 10 rolls. Flour is short by 5000 g, so reorder before ' +
      'you start. Salt is also close to its threshold.',
    highlights: ['Reorder Flour: 5000 g short', 'Salt near threshold'],
    supplyRisk: 'medium' as const,
  };
}

function plan(over: Partial<PrepReorderPlan> = {}): PrepReorderPlan {
  return {
    prepSuggestions: [
      { recipeId: 'r1', recipeName: 'Bread', expectedPortions: 30, batches: 3, hasIssues: false },
    ],
    reorderSuggestions: [
      {
        ingredientId: 'i1',
        ingredientName: 'Flour',
        dimension: 'weight',
        requiredCanonical: 15_000,
        onHandCanonical: 10_000,
        shortfallCanonical: 5000,
      },
    ],
    lowStockWarnings: [
      {
        ingredientId: 'i2',
        ingredientName: 'Salt',
        dimension: 'weight',
        onHandCanonical: 200,
        thresholdCanonical: 500,
        projectedOnHandCanonical: 200,
        causedByPlan: false,
      },
    ],
    issues: [
      { code: 'MISSING_YIELD', recipeId: 'r2', recipeName: 'Soup' },
      { code: 'DELETED_INGREDIENT', recipeId: 'r1', recipeName: 'Bread', ingredientId: 'gone' },
    ],
    hasPlan: true,
    ...over,
  };
}

describe('prepPlanSummarySchema (untrusted boundary)', () => {
  it('accepts a well-formed summary', () => {
    expect(prepPlanSummarySchema.safeParse(validSummary()).success).toBe(true);
  });

  it('defaults highlights to an empty array when omitted', () => {
    const { highlights, ...noHighlights } = validSummary();
    void highlights;
    const parsed = prepPlanSummarySchema.safeParse(noHighlights);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.highlights).toEqual([]);
  });

  it('rejects an invalid supplyRisk', () => {
    expect(
      prepPlanSummarySchema.safeParse({ ...validSummary(), supplyRisk: 'meltdown' }).success,
    ).toBe(false);
  });

  it('rejects too many highlights (UI/memory guard)', () => {
    const bad = { ...validSummary(), highlights: ['a', 'b', 'c', 'd', 'e'] };
    expect(prepPlanSummarySchema.safeParse(bad).success).toBe(false);
  });
});

describe('parsePrepPlanSummaryResponse', () => {
  it('parses valid JSON', () => {
    const out = parsePrepPlanSummaryResponse(JSON.stringify(validSummary()));
    expect(out.supplyRisk).toBe('medium');
    expect(out.highlights).toHaveLength(2);
  });

  it('throws on non-JSON', () => {
    expect(() => parsePrepPlanSummaryResponse('not json')).toThrow(PrepPlanSummaryError);
  });

  it('throws on schema violation', () => {
    expect(() => parsePrepPlanSummaryResponse('{"headline":"x"}')).toThrow(
      PrepPlanSummaryError,
    );
  });
});

describe('buildPrepPlanSummaryFacts (money-free pass-through)', () => {
  it('passes through the computed quantities and issue counts without deriving anything', () => {
    const facts = buildPrepPlanSummaryFacts(plan());
    expect(facts.recipeCount).toBe(1);
    expect(facts.prep).toEqual([{ name: 'Bread', portions: 30, batches: 3 }]);
    expect(facts.reorder).toEqual([
      { name: 'Flour', dimension: 'weight', shortfall: 5000 },
    ]);
    expect(facts.lowStock).toEqual([
      { name: 'Salt', dimension: 'weight', onHand: 200, threshold: 500, projected: 200 },
    ]);
    expect(facts.issues).toEqual({
      missingYield: 1,
      missingLines: 0,
      deletedIngredient: 1,
      unresolvedComponents: 0,
    });
  });

  it('never carries a price/cost field', () => {
    const facts = buildPrepPlanSummaryFacts(plan());
    expect(JSON.stringify(facts)).not.toMatch(/cost|price|cents|margin/i);
  });
});
