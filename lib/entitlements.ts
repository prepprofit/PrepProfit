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
 *     (Business).
 * Numeric caps (recipes, seats) are NOT Clerk features — they live in
 * `PLAN_LIMITS` and are enforced in the app layer. AI photo extraction is UNIVERSAL
 * (every tier, including the free Starter): it is the product differentiator, so it
 * is not gated by a Clerk feature at all — access is metered purely by the monthly
 * quota in `AI_EXTRACTION_MONTHLY_LIMIT` below.
 */

export type PlanTier = 'starter' | 'pro' | 'business';

export type Feature =
  | 'invoices'
  | 'break_even'
  | 'payroll'
  | 'advanced_documents';

/** Numeric limits per tier. `Infinity` = unlimited. */
export const PLAN_LIMITS = {
  starter: { recipes: 10, seats: 1 },
  pro: { recipes: Infinity, seats: 5 },
  business: { recipes: Infinity, seats: Infinity },
} as const satisfies Record<PlanTier, { recipes: number; seats: number }>;

export type PlanLimitKind = keyof (typeof PLAN_LIMITS)[PlanTier];

/**
 * Monthly AI photo-extraction allowance per tier. App-enforced (counted in
 * `ai_extraction_attempts`), NOT a Clerk feature: AI is available on EVERY tier
 * (the free differentiator), so this quota — not a feature flag — is the only thing
 * that meters it. Starter gets a real allowance (10/mo); paid tiers get more.
 * Counted per-ORGANIZATION per calendar month. Tunable here without a deploy of the
 * gating logic.
 */
export const AI_EXTRACTION_MONTHLY_LIMIT = {
  starter: 10,
  pro: 100,
  business: 500,
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
/* Comped orgs (operator / internal) — env-driven allowlist.                  */
/* -------------------------------------------------------------------------- */

/**
 * Org ids that are COMPED to the highest tier (Business, all features) regardless
 * of their Clerk billing state. This is for the SaaS operator's own org(s) and
 * internal/staff orgs — NOT a role bypass: only the exact ids listed in the
 * `COMPED_ORG_IDS` env var (comma-separated) are affected, everything else still
 * reads the real plan fail-closed. Empty/unset by default, so production billing
 * for customers is untouched. Read fresh each call so changing the env var (and
 * redeploying) takes effect without code changes.
 */
function compedOrgIds(): Set<string> {
  return new Set(
    (process.env.COMPED_ORG_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
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
    const { has, orgId } = await auth();
    // Operator/internal comp: a listed org is treated as Business.
    if (orgId && compedOrgIds().has(orgId)) return 'business';
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
    const { has, orgId } = await auth();
    // Operator/internal comp: a listed org has every feature.
    if (orgId && compedOrgIds().has(orgId)) return true;
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
