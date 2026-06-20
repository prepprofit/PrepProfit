import { auth } from '@clerk/nextjs/server';
import type { ActionErrorCode } from '@/lib/action-result';

/**
 * Central server-side entitlements (Sprint 4). The ONE place plan/feature access
 * is read — actions, routes, and pages call these helpers instead of scattering
 * raw Clerk `has()` calls (CLAUDE.md: "Plan/feature entitlement checks are
 * server-side controls … UI hiding is never enough").
 *
 * FAIL-CLOSED: if the entitlement state cannot be determined (Clerk throws, `has`
 * is missing, billing not yet wired), we treat the org as the most restrictive
 * tier (`starter`) and deny paid features — never the reverse.
 *
 * Plan/feature slugs are configured in Clerk → Billing (Organization Plans tab):
 *   - Org plans: `pro`, `business`. Starter = the baseline (no plan check).
 *   - Feature slugs: invoices, break_even (Pro+), payroll, advanced_documents
 *     (Business), ai_extraction (reserved for Sprint 4.7).
 * Numeric caps (recipes, seats) are NOT Clerk features — they live in
 * `PLAN_LIMITS` and are enforced in the app layer.
 */

export type PlanTier = 'starter' | 'pro' | 'business';

export type Feature =
  | 'invoices'
  | 'break_even'
  | 'payroll'
  | 'advanced_documents'
  | 'ai_extraction';

/** Numeric limits per tier. `Infinity` = unlimited. */
export const PLAN_LIMITS = {
  starter: { recipes: 50, seats: 1 },
  pro: { recipes: Infinity, seats: 5 },
  business: { recipes: Infinity, seats: Infinity },
} as const satisfies Record<PlanTier, { recipes: number; seats: number }>;

export type PlanLimitKind = keyof (typeof PLAN_LIMITS)[PlanTier];

/**
 * Monthly AI photo-extraction allowance per tier (Sprint 4.7, D4/Q2). App-enforced
 * (counted in `ai_extraction_attempts`), NOT a Clerk feature — the `ai_extraction`
 * FEATURE flag (Pro/Business) gates access; this map caps usage within it. Starter
 * has no access, hence 0. Tunable here without a deploy of the gating logic.
 */
export const AI_EXTRACTION_MONTHLY_LIMIT = {
  starter: 0,
  pro: 50,
  business: 300,
} as const satisfies Record<PlanTier, number>;

/* -------------------------------------------------------------------------- */
/* Pure helpers (no Clerk I/O) — unit-testable without mocks.                 */
/* -------------------------------------------------------------------------- */

/** True when adding one more of `kind` stays within the tier's cap. */
export function isWithinLimit(
  tier: PlanTier,
  kind: PlanLimitKind,
  currentCount: number,
): boolean {
  return currentCount < PLAN_LIMITS[tier][kind];
}

/* -------------------------------------------------------------------------- */
/* Clerk-bound helpers (server only).                                         */
/* -------------------------------------------------------------------------- */

/**
 * The active org's plan tier, highest first. Fail-closed: any error or an
 * indeterminate state resolves to `starter` (the most restrictive tier).
 */
export async function getPlanTier(): Promise<PlanTier> {
  try {
    const { has } = await auth();
    if (typeof has !== 'function') return 'starter';
    if (has({ plan: 'business' })) return 'business';
    if (has({ plan: 'pro' })) return 'pro';
    return 'starter';
  } catch {
    return 'starter';
  }
}

/** Whether the active org's plan includes `feature`. Fail-closed to `false`. */
export async function canUseFeature(feature: Feature): Promise<boolean> {
  try {
    const { has } = await auth();
    return typeof has === 'function' ? has({ feature }) === true : false;
  } catch {
    return false;
  }
}

/**
 * Gate a paid feature in a Server Action / Route Handler before any data access.
 * Returns `'UPGRADE_REQUIRED'` when the plan lacks the feature, else `null`
 * (allowed). Caller pattern: `const denied = await requireFeature('payroll'); if
 * (denied) return { ok: false, code: denied };`.
 */
export async function requireFeature(
  feature: Feature,
): Promise<Extract<ActionErrorCode, 'UPGRADE_REQUIRED'> | null> {
  return (await canUseFeature(feature)) ? null : 'UPGRADE_REQUIRED';
}

/**
 * Check a numeric plan limit against the current count. `allowed` is true when
 * one more row fits under the tier's cap. Reads the tier fail-closed (`starter`).
 */
export async function assertPlanLimit(
  kind: PlanLimitKind,
  currentCount: number,
): Promise<{ allowed: boolean; limit: number; tier: PlanTier }> {
  const tier = await getPlanTier();
  return {
    allowed: isWithinLimit(tier, kind, currentCount),
    limit: PLAN_LIMITS[tier][kind],
    tier,
  };
}

/**
 * The active org's monthly AI-extraction allowance, read fail-closed (`starter` ⇒
 * 0). The caller compares it against the count of this month's succeeded attempts
 * inside `withOrg` and returns `USAGE_LIMIT_REACHED` when the next call would exceed
 * it. Reads the tier fail-closed so an indeterminate billing state never widens the
 * cap.
 */
export async function aiExtractionMonthlyLimit(): Promise<{
  limit: number;
  tier: PlanTier;
}> {
  const tier = await getPlanTier();
  return { limit: AI_EXTRACTION_MONTHLY_LIMIT[tier], tier };
}
