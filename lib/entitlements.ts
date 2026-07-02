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
 *   - Org plans: `solo`, `pro`, `business`. Starter = the baseline (no plan check).
 *   - Feature slugs: break_even (Solo+), invoices (Pro+), payroll,
 *     advanced_documents (Business).
 * Numeric caps (recipes, seats) are NOT Clerk features — they live in
 * `PLAN_LIMITS` and are enforced in the app layer. AI photo extraction is UNIVERSAL
 * (every tier, including the free Starter): it is the product differentiator, so it
 * is not gated by a Clerk feature at all — access is metered purely by the monthly
 * quota in `AI_EXTRACTION_MONTHLY_LIMIT` below.
 */

export type PlanTier = 'starter' | 'solo' | 'pro' | 'business';

export type Feature =
  | 'invoices'
  | 'break_even'
  | 'payroll'
  | 'advanced_documents';

/** Numeric limits per tier. `Infinity` = unlimited. */
export const PLAN_LIMITS = {
  starter: { recipes: 10, seats: 1 },
  solo: { recipes: Infinity, seats: 1 },
  pro: { recipes: Infinity, seats: 5 },
  business: { recipes: Infinity, seats: Infinity },
} as const satisfies Record<PlanTier, { recipes: number; seats: number }>;

export type PlanLimitKind = keyof (typeof PLAN_LIMITS)[PlanTier];

/**
 * A tier's seat cap expressed the way Clerk's per-organization
 * `max_allowed_memberships` wants it: a positive integer, or `0` for unlimited
 * (Clerk's sentinel). The billing webhook pushes this onto each org so Clerk itself
 * blocks over-cap invites — the only place seats become real enforcement (they are
 * NOT enforced app-side; the app has no invite flow of its own). Free/trial orgs are
 * intentionally left unmanaged (no subscription event), so this only ever runs for a
 * resolved paid/cancelled subscription.
 */
export function clerkSeatLimit(tier: PlanTier): number {
  const seats = PLAN_LIMITS[tier].seats;
  return seats === Infinity ? 0 : seats;
}

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
  solo: 40,
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
  solo: 12,
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
  solo: 40,
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
  // Solo has no `invoices` module → no sales → no posted daily close, so a 0 quota
  // is consistent, not a punishment (pricing plan §2.3 note ¹).
  solo: 0,
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
  solo: 15,
  pro: 30,
  business: 500,
} as const satisfies Record<PlanTier, number>;

/**
 * Monthly AI Weekly CFO Report allowance per tier (Sprint 8, AI margin roadmap).
 * App-enforced (counted in `ai_operation_attempts`, feature `kitchen_cfo_report`), NOT a
 * Clerk feature. The DETERMINISTIC report itself is a manager-only management view of the
 * insight modules; only the premium AI *write-up* is metered. Per the pricing tier matrix
 * (4-tier plan §2.3), the free Starter gets a small trial allowance (2/mo); Solo a few (4);
 * Pro roughly monthly with retries (8); Business weekly (30). Counted per-ORGANIZATION per
 * calendar month. Tunable here without a deploy of the gating logic.
 */
export const WEEKLY_CFO_REPORT_MONTHLY_LIMIT = {
  starter: 2,
  solo: 4,
  pro: 8,
  business: 30,
} as const satisfies Record<PlanTier, number>;

/* -------------------------------------------------------------------------- */
/* Reverse trial — every NEW org gets full (Business) access for a window, then */
/* falls back to Free unless it subscribes. Pure, I/O-free primitives.          */
/* -------------------------------------------------------------------------- */

/** Length of the reverse trial, in days. New org → Business access for this long. */
export const REVERSE_TRIAL_DAYS = 14;

/**
 * Where an effective entitlement came from — drives billing/UI copy so a trial is
 * never shown as a paid subscription:
 *   - `paid`   real Clerk org subscription (solo/pro/business).
 *   - `trial`  reverse trial active (no paid plan yet, within the window).
 *   - `comped` operator/internal comp (COMPED_ORG_IDS).
 *   - `free`   Starter baseline (no plan, no active trial).
 */
export type EntitlementSource = 'paid' | 'trial' | 'comped' | 'free';

/** Resolved, request-time entitlement state for the active org. */
export type EffectiveEntitlementState = {
  tier: PlanTier;
  source: EntitlementSource;
  /** Reverse-trial deadline when known (source `trial`, or `free` after expiry). */
  trialEndsAt: Date | null;
};

/** The reverse-trial deadline for an org created at `createdAtMs` (epoch ms). */
export function computeTrialEndsAt(createdAtMs: number): Date {
  return new Date(createdAtMs + REVERSE_TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * How many days before the trial ends the reminder cron fires. The reminder is sent
 * on the SINGLE calendar day when the trial is exactly this many days out, so a daily
 * cron delivers it at most once (Resend idempotency covers same-day retries).
 */
export const TRIAL_REMINDER_DAYS_BEFORE = 3;

/**
 * Whole UTC-calendar days from `now` until the trial ends (negative once past). Uses
 * UTC midnights so the result is a stable day count independent of clock time —
 * Vercel Cron runs in UTC, so the reminder lands on exactly one calendar day.
 */
export function trialReminderDaysLeft(end: Date, now: Date): number {
  const dayMs = 24 * 60 * 60 * 1000;
  const utcMidnight = (d: Date) =>
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((utcMidnight(end) - utcMidnight(now)) / dayMs);
}

/**
 * True when an org's reverse trial is due its single reminder today: the deadline is
 * known and lands exactly {@link TRIAL_REMINDER_DAYS_BEFORE} calendar days out. The
 * cron additionally checks the org has not already subscribed.
 */
export function isTrialReminderDue(end: Date | null, now: Date): boolean {
  return end != null && trialReminderDaysLeft(end, now) === TRIAL_REMINDER_DAYS_BEFORE;
}

/**
 * Parse the `org_trial_ends_at` session claim into a Date, tolerating the shapes it
 * can arrive as (ISO string, or an epoch-ms number/numeric-string). Any absent,
 * malformed, or non-finite value → `null` (no trial) — fail-closed, never a crash.
 */
export function parseTrialEndsAt(claim: unknown): Date | null {
  if (typeof claim === 'number') {
    return Number.isFinite(claim) ? new Date(claim) : null;
  }
  if (typeof claim !== 'string' || claim.trim() === '') return null;
  // Numeric string → epoch ms; otherwise an ISO/date string.
  const asNumber = Number(claim);
  const ms = Number.isFinite(asNumber) ? asNumber : Date.parse(claim);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

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
 * The ONE request-time entitlement resolution. Reads Clerk once and returns both the
 * resolved {@link EffectiveEntitlementState} and a `featureAllowed` predicate, so
 * `getPlanTier`, `getEffectiveEntitlementState`, and `canUseFeature` all agree.
 *
 * Precedence (fail-closed at every step; any throw → Starter/free, deny all):
 *   1. COMPED org            → Business, all features (`comped`).
 *   2. Real paid org plan    → that tier, Clerk `has({ feature })` (`paid`).
 *   3. Reverse trial active  → Business, all features (`trial`).
 *   4. Otherwise             → Starter, Clerk `has` (which is false) (`free`).
 *
 * Zero extra I/O: the trial deadline is read from the `org_trial_ends_at` session
 * claim (projected from org metadata), never the DB. The trial NEVER stacks on a
 * paid plan — a real subscription resolves at step 2, before the trial is checked.
 */
async function resolveEntitlementContext(): Promise<{
  state: EffectiveEntitlementState;
  featureAllowed: (feature: Feature) => boolean;
}> {
  try {
    const { has, orgId, sessionClaims } = await auth();
    // 1. Operator/internal comp: a listed org is Business with every feature.
    if (orgId && compedOrgIds().has(orgId)) {
      return {
        state: { tier: 'business', source: 'comped', trialEndsAt: null },
        featureAllowed: () => true,
      };
    }
    const hasFn = typeof has === 'function' ? has : null;
    // 2. Real paid tier. Require an active org — org plans are org-payer, so without
    // an org there is no org subscription, and `has({ plan })` must never resolve a
    // personal (user-payer) subscription into an org tier.
    let realTier: PlanTier = 'starter';
    if (orgId && hasFn) {
      if (hasFn({ plan: 'business' })) realTier = 'business';
      else if (hasFn({ plan: 'pro' })) realTier = 'pro';
      else if (hasFn({ plan: 'solo' })) realTier = 'solo';
    }
    if (realTier !== 'starter') {
      return {
        state: { tier: realTier, source: 'paid', trialEndsAt: null },
        featureAllowed: (feature) => (hasFn ? hasFn({ feature }) === true : false),
      };
    }
    // 3. Reverse trial: no paid plan, but still inside the window → full Business.
    const trialEndsAt = orgId
      ? parseTrialEndsAt(sessionClaims?.org_trial_ends_at)
      : null;
    if (trialEndsAt && Date.now() < trialEndsAt.getTime()) {
      return {
        state: { tier: 'business', source: 'trial', trialEndsAt },
        featureAllowed: () => true,
      };
    }
    // 4. Free baseline (trialEndsAt kept for "trial expired" display when present).
    return {
      state: { tier: 'starter', source: 'free', trialEndsAt },
      featureAllowed: (feature) => (hasFn ? hasFn({ feature }) === true : false),
    };
  } catch {
    return {
      state: { tier: 'starter', source: 'free', trialEndsAt: null },
      featureAllowed: () => false,
    };
  }
}

/**
 * The active org's EFFECTIVE entitlement state (tier + source + trial deadline).
 * Use this where the SOURCE matters — e.g. `/billing` must show "Business trial"
 * rather than a paid "Business" subscription. Fail-closed to Starter/free.
 */
export async function getEffectiveEntitlementState(): Promise<EffectiveEntitlementState> {
  return (await resolveEntitlementContext()).state;
}

/**
 * The active org's effective plan tier, highest first. Fail-closed: any error or an
 * indeterminate state resolves to `starter`. During an active reverse trial this
 * returns `business` (the trial grants full access); a real paid plan always wins.
 */
export async function getPlanTier(): Promise<PlanTier> {
  return (await resolveEntitlementContext()).state.tier;
}

/**
 * Whether the active org may use `feature`. Fail-closed to `false`. Comped orgs and
 * orgs in an active reverse trial get every feature; otherwise this reads Clerk
 * `has({ feature })` for the real paid plan.
 */
export async function canUseFeature(feature: Feature): Promise<boolean> {
  return (await resolveEntitlementContext()).featureAllowed(feature);
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

/**
 * The active org's monthly AI Weekly CFO Report allowance (Sprint 8), read fail-closed
 * (`starter` ⇒ 0). The summarize action compares it against the count of this month's
 * reserved attempts inside `withOrg` and returns `USAGE_LIMIT_REACHED` when the next call
 * would exceed it.
 */
export async function weeklyCfoReportMonthlyLimit(): Promise<{
  limit: number;
  tier: PlanTier;
}> {
  const tier = await getPlanTier();
  return { limit: WEEKLY_CFO_REPORT_MONTHLY_LIMIT[tier], tier };
}
