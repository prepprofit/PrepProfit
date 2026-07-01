import { describe, expect, it } from 'vitest';
import { buildExplanationFacts } from './explanation-facts';
import type { ProfitLeakFinding } from './profit-leaks';

/**
 * Pure tests for the AI explanation fact builder (Sprint 4). It must carry through only
 * the finding's own already-computed figures and never fabricate a number — a null
 * margin/cost stays null so the model cannot "explain" an invented figure.
 */

function finding(overrides: Partial<ProfitLeakFinding> = {}): ProfitLeakFinding {
  return {
    fingerprint: 'abc123',
    type: 'RECIPE_BELOW_TARGET_MARGIN',
    severity: 'warning',
    entityType: 'recipe',
    entityId: 'rec-1',
    entityName: 'Cheesecake Slice',
    affectedEntityIds: [],
    currentMarginPercent: 58,
    targetMarginPercent: 65,
    currentCostCents: 206,
    pendingCostCents: null,
    suggestedPriceCents: 589,
    reasonCode: 'BELOW_TARGET_MARGIN',
    ...overrides,
  };
}

describe('buildExplanationFacts', () => {
  it('maps a margin finding into compact facts (money in cents)', () => {
    const facts = buildExplanationFacts(finding());
    expect(facts).toEqual({
      findingType: 'RECIPE_BELOW_TARGET_MARGIN',
      entityType: 'recipe',
      entityName: 'Cheesecake Slice',
      currentMarginPercent: 58,
      targetMarginPercent: 65,
      currentCostCents: 206,
      pendingCostCents: null,
      suggestedPriceCents: 589,
      affectedCount: 0,
      mainDrivers: [],
    });
  });

  it('never fabricates a margin/cost — null finding fields stay null', () => {
    const facts = buildExplanationFacts(
      finding({
        type: 'UNPRICED_INGREDIENT_IN_ACTIVE_RECIPE',
        entityType: 'ingredient',
        currentMarginPercent: null,
        targetMarginPercent: null,
        currentCostCents: null,
        suggestedPriceCents: null,
        affectedEntityIds: ['rec-1', 'rec-2'],
      }),
    );
    expect(facts.currentMarginPercent).toBeNull();
    expect(facts.currentCostCents).toBeNull();
    expect(facts.suggestedPriceCents).toBeNull();
    // affectedCount is derived from the finding, honestly reflecting the fan-out.
    expect(facts.affectedCount).toBe(2);
  });

  it('passes named drivers through untouched (never derives them)', () => {
    const drivers = [{ name: 'Butter', priceChangePercent: 18 }];
    const facts = buildExplanationFacts(finding(), drivers);
    expect(facts.mainDrivers).toEqual(drivers);
  });

  it('carries no DB records — only descriptors + numbers', () => {
    const facts = buildExplanationFacts(finding()) as Record<string, unknown>;
    // entityId is an internal pointer, not something the model needs; ensure it is
    // not leaked into the fact payload.
    expect('entityId' in facts).toBe(false);
    expect('fingerprint' in facts).toBe(false);
  });
});
