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

/**
 * Monthly Supplier Invoice Reader allowance per tier (Sprint 2, AI margin roadmap).
 * App-enforced (counted in `ai_operation_attempts`, feature
 * `supplier_invoice_extraction`), NOT a Clerk feature — like photo extraction, AI is
 * a universal differentiator metered by quota, not gated behind a paid flag. Starter
 * gets a small TRIAL allowance (3/mo, plan §14) so every tier can try it; paid tiers
 * get more. Counted per-ORGANIZATION per calendar month. Tunable here without a deploy
 * of the gating logic.
 */
export const SUPPLIER_INVOICE_MONTHLY_LIMIT = {
  starter: 3,
  pro: 30,
  business: 200,
} as const satisfies Record<PlanTier, number>;

/**
 * Monthly AI profit-leak explanation allowance per tier (Sprint 4, AI margin roadmap).
 * App-enforced (counted in `ai_operation_attempts`, feature `profit_leak_explanation`),
 * NOT a Clerk feature — like the other AI features, explanations are a universal
 * differentiator metered by quota, not gated behind a paid flag. Starter gets a real
 * trial allowance (10/mo, matching photo extraction, plan §14 "limited"); paid tiers
 * get more. Counted per-ORGANIZATION per calendar month. Tunable here without a deploy
 * of the gating logic.
 */
export const PROFIT_LEAK_EXPLANATION_MONTHLY_LIMIT = {
  starter: 10,
  pro: 100,
  business: 500,
} as const satisfies Record<PlanTier, number>;

/**
 * Monthly AI Daily Close Summary allowance per tier (Sprint 6, AI margin roadmap).
 * App-enforced (counted in `ai_operation_attempts`, feature `daily_close_summary`), NOT a
 * Clerk feature. UNLIKE the other AI features, the free Starter gets 0 here (plan §14: the
 * daily-close summary is a paid-tier operator tool, and Starter can't reach a posted close
 * anyway — the sales module is `invoices`-gated). Pro/Business get real allowances.
 * Counted per-ORGANIZATION per calendar month. Tunable here without a deploy of the gating
 * logic.
 */
export const DAILY_CLOSE_SUMMARY_MONTHLY_LIMIT = {
  starter: 0,
  pro: 30,
  business: 500,
} as const satisfies Record<PlanTier, number>;

/**
 * Monthly AI Prep/Reorder Plan Summary allowance per tier (Sprint 7, AI margin roadmap).
 * App-enforced (counted in `ai_operation_attempts`, feature `prep_reorder_plan_summary`),
 * NOT a Clerk feature. The DETERMINISTIC planner itself is universal operational value (all
 * tiers, both roles, money-free) — only the optional AI *formatting* is metered. Per the
 * roadmap tier matrix (plan §14 "no / limited / full"), the free Starter gets 0 AI
 * summaries; Pro/Business get real allowances. Counted per-ORGANIZATION per calendar month.
 * Tunable here without a deploy of the gating logic.
 */
export const PREP_PLAN_SUMMARY_MONTHLY_LIMIT = {
  starter: 0,
  pro: 30,
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
/* Generated-document entitlement matrix (audit F-08).                        */
/* -------------------------------------------------------------------------- */

/**
 * Every downloadable/printable document the app generates. The SINGLE source of
 * truth for which documents are gated behind the Business `advanced_documents`
 * feature vs available on every plan.
 *
 * Scope: this matrix governs ONLY the `advanced_documents` axis. Documents that
 * live behind a different feature flag (payroll PDF/XLSX → `payroll`; invoice PDF
 * → `invoices`) or that are purely operational are NOT gated here — they keep their
 * own module's gate. The point is to codify, and lock with a test
 * (tests/document-entitlements.test.ts), the boundary the audit found implicit:
 * financial/reporting deliverables are `advanced`; operational kitchen/purchasing
 * outputs are free. Routes consult `requireDocumentAccess()` so the boundary can
 * never drift silently.
 */
export type GeneratedDocument =
  // Financial reporting deliverables — Business `advanced_documents`.
  | 'pl_pdf'
  | 'pl_xlsx'
  | 'financials_print'
  // Operational outputs — every plan (their own RBAC still applies).
  | 'recipe_card_pdf'
  | 'recipe_prep_card_pdf'
  | 'allergen_matrix_pdf'
  | 'allergen_matrix_xlsx'
  | 'purchase_order_pdf';

export const GENERATED_DOCUMENTS = {
  pl_pdf: 'advanced',
  pl_xlsx: 'advanced',
  financials_print: 'advanced',
  recipe_card_pdf: 'operational',
  recipe_prep_card_pdf: 'operational',
  allergen_matrix_pdf: 'operational',
  allergen_matrix_xlsx: 'operational',
  purchase_order_pdf: 'operational',
} as const satisfies Record<GeneratedDocument, 'advanced' | 'operational'>;

/** True when the document is gated behind the Business `advanced_documents` feature. */
export function documentRequiresAdvanced(doc: GeneratedDocument): boolean {
  return GENERATED_DOCUMENTS[doc] === 'advanced';
}

/**
 * Gate a generated document before rendering it. Returns `'UPGRADE_REQUIRED'` when
 * the document needs `advanced_documents` and the plan lacks it, else `null`
 * (allowed). Operational documents are always `null` here — their module-level RBAC
 * (manager-only, feature flag) is enforced separately at the call site.
 */
export async function requireDocumentAccess(
  doc: GeneratedDocument,
): Promise<Extract<ActionErrorCode, 'UPGRADE_REQUIRED'> | null> {
  if (!documentRequiresAdvanced(doc)) return null;
  return (await canUseFeature('advanced_documents')) ? null : 'UPGRADE_REQUIRED';
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

/**
 * The active org's monthly Supplier Invoice Reader allowance (Sprint 2), read
 * fail-closed (`starter`). The upload route compares it against the count of this
 * month's reserved attempts inside `withOrg` and returns `USAGE_LIMIT_REACHED` when
 * the next call would exceed it.
 */
export async function supplierInvoiceMonthlyLimit(): Promise<{
  limit: number;
  tier: PlanTier;
}> {
  const tier = await getPlanTier();
  return { limit: SUPPLIER_INVOICE_MONTHLY_LIMIT[tier], tier };
}

/**
 * The active org's monthly AI profit-leak explanation allowance (Sprint 4), read
 * fail-closed (`starter`). The explain action compares it against the count of this
 * month's reserved attempts inside `withOrg` and returns `USAGE_LIMIT_REACHED` when the
 * next call would exceed it.
 */
export async function profitLeakExplanationMonthlyLimit(): Promise<{
  limit: number;
  tier: PlanTier;
}> {
  const tier = await getPlanTier();
  return { limit: PROFIT_LEAK_EXPLANATION_MONTHLY_LIMIT[tier], tier };
}

/**
 * The active org's monthly AI Daily Close Summary allowance (Sprint 6), read fail-closed
 * (`starter` ⇒ 0). The summarize action compares it against the count of this month's
 * reserved attempts inside `withOrg` and returns `USAGE_LIMIT_REACHED` when the next call
 * would exceed it.
 */
export async function dailyCloseSummaryMonthlyLimit(): Promise<{
  limit: number;
  tier: PlanTier;
}> {
  const tier = await getPlanTier();
  return { limit: DAILY_CLOSE_SUMMARY_MONTHLY_LIMIT[tier], tier };
}

/**
 * The active org's monthly AI Prep/Reorder Plan Summary allowance (Sprint 7), read
 * fail-closed (`starter` ⇒ 0). The summarize action compares it against the count of this
 * month's reserved attempts inside `withOrg` and returns `USAGE_LIMIT_REACHED` when the next
 * call would exceed it.
 */
export async function prepPlanSummaryMonthlyLimit(): Promise<{
  limit: number;
  tier: PlanTier;
}> {
  const tier = await getPlanTier();
  return { limit: PREP_PLAN_SUMMARY_MONTHLY_LIMIT[tier], tier };
}
