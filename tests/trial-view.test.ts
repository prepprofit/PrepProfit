import { describe, expect, it } from 'vitest';
import type { EffectiveEntitlementState } from '@/lib/entitlements';
import { deriveTrialView, trialDaysLeft, type TrialView } from '@/lib/trial';

/**
 * Pure tests for the reverse-trial UI read-model (`lib/trial.ts`). No Clerk/DB I/O —
 * `deriveTrialView` and `trialDaysLeft` are projections over an already-resolved
 * entitlement state. Covers the UTC calendar-day clamp, the trial-only gate, and the
 * serializable shape crossing into client components.
 */

const NOW = new Date('2026-07-03T13:45:00Z');

function trialState(endsAtIso: string | null): EffectiveEntitlementState {
  return {
    tier: 'business',
    source: 'trial',
    trialEndsAt: endsAtIso == null ? null : new Date(endsAtIso),
  };
}

describe('trialDaysLeft', () => {
  it('counts whole UTC calendar days left', () => {
    expect(trialDaysLeft(new Date('2026-07-17T00:00:00Z'), NOW)).toBe(14);
    expect(trialDaysLeft(new Date('2026-07-04T00:00:00Z'), NOW)).toBe(1);
    expect(trialDaysLeft(new Date('2026-07-03T00:00:00Z'), NOW)).toBe(0);
  });

  it('clamps an expired deadline to 0 instead of going negative', () => {
    expect(trialDaysLeft(new Date('2026-06-30T00:00:00Z'), NOW)).toBe(0);
  });

  it('returns 0 for a null deadline', () => {
    expect(trialDaysLeft(null, NOW)).toBe(0);
  });
});

describe('deriveTrialView', () => {
  it('projects an active trial with 14 days left', () => {
    const view = deriveTrialView(trialState('2026-07-17T00:00:00Z'), NOW);
    expect(view).toEqual<TrialView>({
      source: 'trial',
      daysLeft: 14,
      endsToday: false,
      trialEndsAtIso: '2026-07-17T00:00:00.000Z',
    });
  });

  it('flags the last day with endsToday and daysLeft 0', () => {
    const view = deriveTrialView(trialState('2026-07-03T09:00:00Z'), NOW);
    expect(view?.daysLeft).toBe(0);
    expect(view?.endsToday).toBe(true);
  });

  it('clamps a past deadline (forced trial-shaped state) to 0 / endsToday', () => {
    const view = deriveTrialView(trialState('2026-06-29T00:00:00Z'), NOW);
    expect(view?.daysLeft).toBe(0);
    expect(view?.endsToday).toBe(true);
  });

  it('returns null when the trial deadline is unknown', () => {
    expect(deriveTrialView(trialState(null), NOW)).toBeNull();
  });

  it('returns null for paid, free, and comped sources', () => {
    for (const source of ['paid', 'free', 'comped'] as const) {
      const state: EffectiveEntitlementState = {
        tier: 'business',
        source,
        trialEndsAt: new Date('2026-07-17T00:00:00Z'),
      };
      expect(deriveTrialView(state, NOW)).toBeNull();
    }
  });

  it('exposes trialEndsAtIso as an ISO string, not a Date', () => {
    const view = deriveTrialView(trialState('2026-07-17T00:00:00Z'), NOW);
    expect(typeof view?.trialEndsAtIso).toBe('string');
  });
});
