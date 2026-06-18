import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the central entitlements helper (Sprint 4, slice 4a). The key
 * invariant is FAIL-CLOSED: when the plan/feature state cannot be determined
 * (Clerk throws, `has` missing), the org resolves to the most restrictive tier
 * (`starter`) and paid features are denied — never the reverse.
 */
type HasFn = (params: { plan?: string; feature?: string }) => boolean;

const h = vi.hoisted(() => ({
  auth: null as null | (() => Promise<{ has?: HasFn }>),
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: () => h.auth!(),
}));

import {
  PLAN_LIMITS,
  isWithinLimit,
  getPlanTier,
  canUseFeature,
  requireFeature,
  assertPlanLimit,
} from '@/lib/entitlements';

/** Point `auth()` at a fake `has`, or make it throw / omit `has`. */
function setHas(fn: HasFn) {
  h.auth = async () => ({ has: fn });
}

afterEach(() => {
  h.auth = null;
  vi.restoreAllMocks();
});

describe('isWithinLimit (pure)', () => {
  it('enforces the Starter recipe cap at the boundary', () => {
    expect(isWithinLimit('starter', 'recipes', 49)).toBe(true);
    expect(isWithinLimit('starter', 'recipes', 50)).toBe(false);
    expect(isWithinLimit('starter', 'recipes', 51)).toBe(false);
  });

  it('treats Pro/Business as unlimited recipes', () => {
    expect(isWithinLimit('pro', 'recipes', 10_000)).toBe(true);
    expect(isWithinLimit('business', 'recipes', 1_000_000)).toBe(true);
    expect(PLAN_LIMITS.pro.recipes).toBe(Infinity);
    expect(PLAN_LIMITS.business.recipes).toBe(Infinity);
  });

  it('keeps the documented seat caps', () => {
    expect(PLAN_LIMITS.starter.seats).toBe(1);
    expect(PLAN_LIMITS.pro.seats).toBe(5);
    expect(PLAN_LIMITS.business.seats).toBe(Infinity);
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

  it('returns starter when no paid plan is active', async () => {
    setHas(() => false);
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

describe('assertPlanLimit', () => {
  it('blocks a Starter org at its 50th recipe', async () => {
    setHas(() => false); // starter
    const r = await assertPlanLimit('recipes', 50);
    expect(r).toEqual({ allowed: false, limit: 50, tier: 'starter' });
  });

  it('allows a Starter org under the cap', async () => {
    setHas(() => false);
    const r = await assertPlanLimit('recipes', 49);
    expect(r.allowed).toBe(true);
  });

  it('never blocks recipes on Pro/Business', async () => {
    setHas(({ plan }) => plan === 'pro');
    const r = await assertPlanLimit('recipes', 99_999);
    expect(r).toEqual({ allowed: true, limit: Infinity, tier: 'pro' });
  });
});
