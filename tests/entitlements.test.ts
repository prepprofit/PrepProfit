import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the central entitlements helper (Sprint 4, slice 4a). The key
 * invariant is FAIL-CLOSED: when the plan/feature state cannot be determined
 * (Clerk throws, `has` missing), the org resolves to the most restrictive tier
 * (`starter`) and paid features are denied — never the reverse.
 */
type HasFn = (params: { plan?: string; feature?: string }) => boolean;
type SessionClaims = { org_trial_ends_at?: string };

const h = vi.hoisted(() => ({
  auth: null as
    | null
    | (() => Promise<{ has?: HasFn; orgId?: string; sessionClaims?: SessionClaims }>),
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: () => h.auth!(),
}));

import {
  PLAN_LIMITS,
  AI_EXTRACTION_MONTHLY_LIMIT,
  SUPPLIER_INVOICE_MONTHLY_LIMIT,
  PROFIT_LEAK_EXPLANATION_MONTHLY_LIMIT,
  DAILY_CLOSE_SUMMARY_MONTHLY_LIMIT,
  PREP_PLAN_SUMMARY_MONTHLY_LIMIT,
  WEEKLY_CFO_REPORT_MONTHLY_LIMIT,
  REVERSE_TRIAL_DAYS,
  TRIAL_REMINDER_DAYS_BEFORE,
  clerkSeatLimit,
  isWithinLimit,
  getPlanTier,
  getEffectiveEntitlementState,
  canUseFeature,
  requireFeature,
  assertPlanLimit,
  computeTrialEndsAt,
  parseTrialEndsAt,
  trialReminderDaysLeft,
  isTrialReminderDue,
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

/**
 * Point `auth()` at an org with an `org_trial_ends_at` session claim (reverse trial),
 * optionally also carrying a real paid plan via `has` (defaults to no plan).
 */
function setTrial(claimIso: string | undefined, has: HasFn = () => false) {
  h.auth = async () => ({
    has,
    orgId: 'org_test',
    sessionClaims: claimIso ? { org_trial_ends_at: claimIso } : {},
  });
}

const future = () => new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
const past = () => new Date(Date.now() - 1000).toISOString();

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

  it('maps seat caps to Clerk max_allowed_memberships (Infinity → 0 sentinel)', () => {
    expect(clerkSeatLimit('starter')).toBe(1);
    expect(clerkSeatLimit('solo')).toBe(1);
    expect(clerkSeatLimit('pro')).toBe(5);
    expect(clerkSeatLimit('business')).toBe(0);
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

describe('Solo tier — feature matrix + caps (pricing 4-tier plan §2)', () => {
  /** A realistic Solo `has`: the `solo` plan and ONLY the `break_even` feature. */
  const soloHas: HasFn = ({ plan, feature }) =>
    plan === 'solo' || feature === 'break_even';

  it('resolves to the solo tier with break_even but nothing higher', async () => {
    setHas(soloHas);
    expect(await getPlanTier()).toBe('solo');
    expect(await canUseFeature('break_even')).toBe(true);
    // Solo must NOT unlock Pro/Business modules.
    expect(await canUseFeature('invoices')).toBe(false);
    expect(await requireFeature('invoices')).toBe('UPGRADE_REQUIRED');
    expect(await canUseFeature('payroll')).toBe(false);
    expect(await canUseFeature('advanced_documents')).toBe(false);
    expect((await getEffectiveEntitlementState()).source).toBe('paid');
  });

  it('caps: 1 seat, unlimited recipes', async () => {
    setHas(soloHas);
    expect(await assertPlanLimit('recipes', 100_000)).toEqual({
      allowed: true,
      limit: Infinity,
      tier: 'solo',
    });
    expect(await assertPlanLimit('seats', 1)).toEqual({
      allowed: false,
      limit: 1,
      tier: 'solo',
    });
  });

  it('sits on the Free<Solo<Pro<Business AI quota ladder (§2.3)', () => {
    expect(AI_EXTRACTION_MONTHLY_LIMIT.solo).toBe(40);
    expect(SUPPLIER_INVOICE_MONTHLY_LIMIT.solo).toBe(12);
    expect(PROFIT_LEAK_EXPLANATION_MONTHLY_LIMIT.solo).toBe(40);
    // No sales module on Solo → no daily close → 0 is consistent, not a punishment.
    expect(DAILY_CLOSE_SUMMARY_MONTHLY_LIMIT.solo).toBe(0);
    expect(PREP_PLAN_SUMMARY_MONTHLY_LIMIT.solo).toBe(15);
    expect(WEEKLY_CFO_REPORT_MONTHLY_LIMIT.solo).toBe(4);
    // Each quota is strictly ordered Free ≤ Solo ≤ Pro ≤ Business.
    for (const q of [
      AI_EXTRACTION_MONTHLY_LIMIT,
      SUPPLIER_INVOICE_MONTHLY_LIMIT,
      PROFIT_LEAK_EXPLANATION_MONTHLY_LIMIT,
      DAILY_CLOSE_SUMMARY_MONTHLY_LIMIT,
      PREP_PLAN_SUMMARY_MONTHLY_LIMIT,
      WEEKLY_CFO_REPORT_MONTHLY_LIMIT,
    ]) {
      expect(q.starter).toBeLessThanOrEqual(q.solo);
      expect(q.solo).toBeLessThanOrEqual(q.pro);
      expect(q.pro).toBeLessThanOrEqual(q.business);
    }
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

describe('reverse trial (pure helpers)', () => {
  it('computeTrialEndsAt adds exactly the trial window to created_at', () => {
    const created = Date.parse('2026-06-20T00:00:00Z');
    expect(computeTrialEndsAt(created).toISOString()).toBe('2026-07-04T00:00:00.000Z');
    expect(REVERSE_TRIAL_DAYS).toBe(14);
  });

  it('parseTrialEndsAt tolerates ISO strings, epoch numbers, and numeric strings', () => {
    expect(parseTrialEndsAt('2026-07-04T00:00:00.000Z')).toEqual(
      new Date('2026-07-04T00:00:00.000Z'),
    );
    expect(parseTrialEndsAt(1000)).toEqual(new Date(1000));
    expect(parseTrialEndsAt('1000')).toEqual(new Date(1000));
  });

  it('parseTrialEndsAt fail-closes to null on absent/malformed values', () => {
    expect(parseTrialEndsAt(undefined)).toBeNull();
    expect(parseTrialEndsAt(null)).toBeNull();
    expect(parseTrialEndsAt('')).toBeNull();
    expect(parseTrialEndsAt('   ')).toBeNull();
    expect(parseTrialEndsAt('not-a-date')).toBeNull();
    expect(parseTrialEndsAt(NaN)).toBeNull();
    expect(parseTrialEndsAt(Infinity)).toBeNull();
  });

  it('trialReminderDaysLeft counts whole UTC calendar days regardless of clock time', () => {
    const now = new Date('2026-07-03T23:30:00Z');
    // Same UTC date + 3, even though the end clock time is earlier in the day.
    expect(trialReminderDaysLeft(new Date('2026-07-06T01:00:00Z'), now)).toBe(3);
    expect(trialReminderDaysLeft(new Date('2026-07-04T00:00:00Z'), now)).toBe(1);
    expect(trialReminderDaysLeft(new Date('2026-07-03T05:00:00Z'), now)).toBe(0);
    expect(trialReminderDaysLeft(new Date('2026-07-02T23:00:00Z'), now)).toBe(-1);
  });

  it('isTrialReminderDue fires only on the single N-days-out day', () => {
    const now = new Date('2026-07-03T08:00:00Z');
    expect(TRIAL_REMINDER_DAYS_BEFORE).toBe(3);
    expect(isTrialReminderDue(new Date('2026-07-06T20:00:00Z'), now)).toBe(true);
    expect(isTrialReminderDue(new Date('2026-07-05T20:00:00Z'), now)).toBe(false);
    expect(isTrialReminderDue(new Date('2026-07-07T20:00:00Z'), now)).toBe(false);
    expect(isTrialReminderDue(null, now)).toBe(false);
  });
});

describe('reverse trial (request-time override)', () => {
  it('grants Business tier + every feature while the trial is active', async () => {
    setTrial(future());
    expect(await getPlanTier()).toBe('business');
    expect(await canUseFeature('invoices')).toBe(true);
    expect(await canUseFeature('payroll')).toBe(true);
    expect(await canUseFeature('advanced_documents')).toBe(true);
    const state = await getEffectiveEntitlementState();
    expect(state.source).toBe('trial');
    expect(state.tier).toBe('business');
    expect(state.trialEndsAt).toBeInstanceOf(Date);
  });

  it('falls back to Starter/free once the trial has expired', async () => {
    setTrial(past());
    expect(await getPlanTier()).toBe('starter');
    expect(await canUseFeature('invoices')).toBe(false);
    const state = await getEffectiveEntitlementState();
    expect(state.source).toBe('free');
    // The deadline is still surfaced so /billing can show "trial ended".
    expect(state.trialEndsAt).toBeInstanceOf(Date);
  });

  it('never stacks on a real paid plan — the paid plan wins', async () => {
    // Org has an active trial claim AND a real Pro subscription (plan + its features).
    setTrial(
      future(),
      ({ plan, feature }) =>
        plan === 'pro' || feature === 'invoices' || feature === 'break_even',
    );
    expect(await getPlanTier()).toBe('pro');
    // Pro does not include payroll; the trial must NOT re-open it.
    expect(await canUseFeature('payroll')).toBe(false);
    expect(await canUseFeature('invoices')).toBe(true);
    const state = await getEffectiveEntitlementState();
    expect(state.source).toBe('paid');
    expect(state.trialEndsAt).toBeNull();
  });

  it('grants no trial when the claim is absent or malformed', async () => {
    setTrial(undefined);
    expect(await getPlanTier()).toBe('starter');
    expect(await canUseFeature('invoices')).toBe(false);

    setTrial('not-a-date');
    expect(await getPlanTier()).toBe('starter');
  });

  it('grants no trial with no active org, even with a claim present', async () => {
    h.auth = async () => ({ has: () => false, sessionClaims: { org_trial_ends_at: future() } });
    expect(await getPlanTier()).toBe('starter');
    expect((await getEffectiveEntitlementState()).source).toBe('free');
  });

  it('comped orgs stay Business/comped regardless of any trial claim', async () => {
    process.env.COMPED_ORG_IDS = 'org_test';
    setTrial(past());
    expect(await getPlanTier()).toBe('business');
    expect(await canUseFeature('payroll')).toBe(true);
    expect((await getEffectiveEntitlementState()).source).toBe('comped');
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
