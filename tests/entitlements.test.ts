import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the central entitlements helper (Sprint 4, slice 4a). The key
 * invariant is FAIL-CLOSED: when the plan/feature state cannot be determined
 * (Clerk throws, `has` missing), the org resolves to the most restrictive tier
 * (`starter`) and paid features are denied — never the reverse.
 */
type HasFn = (params: { plan?: string; feature?: string }) => boolean;

const h = vi.hoisted(() => ({
  auth: null as null | (() => Promise<{ has?: HasFn; orgId?: string }>),
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: () => h.auth!(),
}));

import {
  PLAN_LIMITS,
  AI_EXTRACTION_MONTHLY_LIMIT,
  PROFIT_LEAK_EXPLANATION_MONTHLY_LIMIT,
  isWithinLimit,
  getPlanTier,
  canUseFeature,
  requireFeature,
  assertPlanLimit,
  profitLeakExplanationMonthlyLimit,
} from '@/lib/entitlements';

/**
 * Point `auth()` at a fake `has` with an active org (getPlanTier now requires an
 * orgId before any plan check, so tests must supply one).
 */
function setHas(fn: HasFn) {
  h.auth = async () => ({ has: fn, orgId: 'org_test' });
}

/** Point `auth()` at a fake `has` + an active org id (for comp-allowlist tests). */
function setAuth(fn: HasFn, orgId: string) {
  h.auth = async () => ({ has: fn, orgId });
}

afterEach(() => {
  h.auth = null;
  delete process.env.COMPED_ORG_IDS;
  vi.restoreAllMocks();
});

describe('isWithinLimit (pure)', () => {
  it('enforces the Starter recipe cap at the boundary', () => {
    expect(isWithinLimit('starter', 'recipes', 9)).toBe(true);
    expect(isWithinLimit('starter', 'recipes', 10)).toBe(false);
    expect(isWithinLimit('starter', 'recipes', 11)).toBe(false);
  });

  it('treats Pro/Business as unlimited recipes', () => {
    expect(isWithinLimit('pro', 'recipes', 10_000)).toBe(true);
    expect(isWithinLimit('business', 'recipes', 1_000_000)).toBe(true);
    expect(PLAN_LIMITS.pro.recipes).toBe(Infinity);
    expect(PLAN_LIMITS.business.recipes).toBe(Infinity);
  });

  it('keeps the documented seat caps', () => {
    expect(PLAN_LIMITS.starter.seats).toBe(1);
    expect(PLAN_LIMITS.solo.seats).toBe(1);
    expect(PLAN_LIMITS.pro.seats).toBe(5);
    expect(PLAN_LIMITS.business.seats).toBe(Infinity);
  });

  it('caps free recipes at 10, but Solo is unlimited on a single seat', () => {
    expect(PLAN_LIMITS.starter.recipes).toBe(10);
    expect(PLAN_LIMITS.solo.recipes).toBe(Infinity);
    expect(isWithinLimit('solo', 'recipes', 1_000_000)).toBe(true);
    expect(isWithinLimit('solo', 'seats', 1)).toBe(false);
  });
});

describe('AI_EXTRACTION_MONTHLY_LIMIT (universal feature, quota-metered)', () => {
  it('gives every tier — including free Starter — a real monthly allowance', () => {
    // AI is the differentiator: free is NOT zero (it used to be), it is metered.
    expect(AI_EXTRACTION_MONTHLY_LIMIT.starter).toBe(10);
    expect(AI_EXTRACTION_MONTHLY_LIMIT.solo).toBe(40);
    expect(AI_EXTRACTION_MONTHLY_LIMIT.pro).toBe(100);
    expect(AI_EXTRACTION_MONTHLY_LIMIT.business).toBe(500);
  });
});

describe('PROFIT_LEAK_EXPLANATION_MONTHLY_LIMIT (universal feature, quota-metered)', () => {
  it('gives every tier a monthly allowance, matching photo extraction on Starter', () => {
    expect(PROFIT_LEAK_EXPLANATION_MONTHLY_LIMIT.starter).toBe(10);
    expect(PROFIT_LEAK_EXPLANATION_MONTHLY_LIMIT.pro).toBe(100);
    expect(PROFIT_LEAK_EXPLANATION_MONTHLY_LIMIT.business).toBe(500);
  });

  it('resolves the active tier allowance, fail-closed to starter when auth() throws', async () => {
    setHas(({ plan }) => plan === 'business');
    expect(await profitLeakExplanationMonthlyLimit()).toEqual({ limit: 500, tier: 'business' });

    h.auth = async () => {
      throw new Error('clerk down');
    };
    expect(await profitLeakExplanationMonthlyLimit()).toEqual({ limit: 10, tier: 'starter' });
  });
});

describe('getPlanTier', () => {
  it('returns business when the business plan is active', async () => {
    setHas(({ plan }) => plan === 'business');
    expect(await getPlanTier()).toBe('business');
  });

  it('returns pro when only the pro plan is active', async () => {
    setHas(({ plan }) => plan === 'pro');
    expect(await getPlanTier()).toBe('pro');
  });

  it('returns solo when only the solo plan is active', async () => {
    setHas(({ plan }) => plan === 'solo');
    expect(await getPlanTier()).toBe('solo');
  });

  it('prefers the higher tier when multiple plans would match', async () => {
    // Defensive: business outranks pro/solo even if has() answered true for all.
    setHas(() => true);
    expect(await getPlanTier()).toBe('business');
  });

  it('returns starter when no paid plan is active', async () => {
    setHas(() => false);
    expect(await getPlanTier()).toBe('starter');
  });

  it('fail-closes to starter when there is no active org', async () => {
    h.auth = async () => ({ has: () => true }); // has() would say yes, but no orgId
    expect(await getPlanTier()).toBe('starter');
  });

  it('fail-closes to starter when auth() throws', async () => {
    h.auth = async () => {
      throw new Error('clerk down');
    };
    expect(await getPlanTier()).toBe('starter');
  });

  it('fail-closes to starter when has is unavailable', async () => {
    h.auth = async () => ({});
    expect(await getPlanTier()).toBe('starter');
  });
});

describe('canUseFeature / requireFeature', () => {
  it('allows a feature the plan includes', async () => {
    setHas(({ feature }) => feature === 'payroll');
    expect(await canUseFeature('payroll')).toBe(true);
    expect(await requireFeature('payroll')).toBeNull();
  });

  it('denies a feature the plan lacks', async () => {
    setHas(() => false);
    expect(await canUseFeature('payroll')).toBe(false);
    expect(await requireFeature('payroll')).toBe('UPGRADE_REQUIRED');
  });

  it('fail-closes to denied when auth() throws', async () => {
    h.auth = async () => {
      throw new Error('clerk down');
    };
    expect(await canUseFeature('invoices')).toBe(false);
    expect(await requireFeature('invoices')).toBe('UPGRADE_REQUIRED');
  });
});

describe('comped orgs (COMPED_ORG_IDS allowlist)', () => {
  const OPERATOR = 'org_operator';

  it('grants Business tier + every feature to a listed org with no paid plan', async () => {
    process.env.COMPED_ORG_IDS = `org_other, ${OPERATOR} `; // spaces/extra ids tolerated
    setAuth(() => false, OPERATOR); // Clerk says: no plan, no feature
    expect(await getPlanTier()).toBe('business');
    expect(await canUseFeature('invoices')).toBe(true);
    expect(await canUseFeature('payroll')).toBe(true);
    const cap = await assertPlanLimit('recipes', 99_999);
    expect(cap).toEqual({ allowed: true, limit: Infinity, tier: 'business' });
  });

  it('does NOT affect an org that is not on the list', async () => {
    process.env.COMPED_ORG_IDS = OPERATOR;
    setAuth(() => false, 'org_customer');
    expect(await getPlanTier()).toBe('starter');
    expect(await canUseFeature('invoices')).toBe(false);
  });

  it('is inert when COMPED_ORG_IDS is unset (default: customer gating untouched)', async () => {
    setAuth(() => false, OPERATOR);
    expect(await getPlanTier()).toBe('starter');
    expect(await canUseFeature('invoices')).toBe(false);
  });
});

describe('assertPlanLimit', () => {
  it('blocks a Starter org at its 10th recipe', async () => {
    setHas(() => false); // starter
    const r = await assertPlanLimit('recipes', 10);
    expect(r).toEqual({ allowed: false, limit: 10, tier: 'starter' });
  });

  it('allows a Starter org under the cap', async () => {
    setHas(() => false);
    const r = await assertPlanLimit('recipes', 9);
    expect(r.allowed).toBe(true);
  });

  it('never blocks recipes on Pro/Business', async () => {
    setHas(({ plan }) => plan === 'pro');
    const r = await assertPlanLimit('recipes', 99_999);
    expect(r).toEqual({ allowed: true, limit: Infinity, tier: 'pro' });
  });
});
