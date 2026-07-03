import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  allAiMonthlyLimits,
  type EntitlementSource,
  type PlanTier,
} from '@/lib/entitlements';
import { AI_USAGE_FEATURES, type AiUsageFeature } from '@/lib/ai/usage-features';
import {
  countExtractionUsageSince,
  monthStartUtc,
} from '@/lib/data/ai-extraction';
import { countOperationUsageByFeatureSince } from '@/lib/data/ai-operation-attempts';

/**
 * Server read model for the AI USAGE METER (used / remaining per feature this month).
 * DISPLAY only: it reports what the ledgers already recorded — it never authorizes an
 * AI call. Cap enforcement stays with the per-feature route/action gates (reserved
 * count under an advisory lock). The two numbers here are deliberately distinct:
 *
 *   - `used`  — billed usage: `succeeded` rows since the UTC month start.
 *   - `reserved` — `used` PLUS still-in-flight `pending` rows (what the gate sees), so
 *     the photo upload hint never promises a slot that is already reserved.
 *
 * Org-scoped (RULE #1): the org id is derived server-side and the reads run inside
 * `withOrg`, so RLS is the second layer.
 */

/** One metered feature's current-month usage, ready for a meter row. */
export type AiUsageRow = {
  feature: AiUsageFeature;
  /** Billed usage — `succeeded` this month. */
  used: number;
  /** `used` + still-in-flight `pending` (the cap-gate figure). */
  reserved: number;
  /** Effective monthly allowance for the active tier (trial-clamped). */
  limit: number;
  /** `max(0, limit - used)` — never negative even after a downgrade/over-cap. */
  remaining: number;
  /** `max(0, limit - reserved)` — real headroom for a new call right now. */
  availableNow: number;
};

/** The whole meter: shared tier/source + reset date + one row per metered feature. */
export type AiUsageSummary = {
  tier: PlanTier;
  source: EntitlementSource;
  /** First instant of the next UTC month — when every counter resets. */
  resetAt: Date;
  rows: AiUsageRow[];
};

/** First day of the UTC month AFTER `now` — the usage reset boundary. */
export function nextMonthResetUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Pure meter-row math for a feature from its raw counts + effective limit. Truthful
 * over-cap handling: if `used > limit` (downgrade / trial-cap change), `remaining`
 * clamps to 0 rather than going negative; the caller still shows the real `used`.
 */
export function buildUsageRow(
  feature: AiUsageFeature,
  counts: { used: number; reserved: number },
  limit: number,
): AiUsageRow {
  return {
    feature,
    used: counts.used,
    reserved: counts.reserved,
    limit,
    remaining: Math.max(0, limit - counts.used),
    availableNow: Math.max(0, limit - counts.reserved),
  };
}

const ZERO_COUNTS = { used: 0, reserved: 0 } as const;

/**
 * Current-month AI usage for EVERY metered feature (the `/billing` meter). Resolves all
 * effective limits from one entitlement read, then reads both ledgers inside a single
 * `withOrg` transaction. Rows come back in {@link AI_USAGE_FEATURES} display order;
 * `menu_engineering_explanation` is never included (it is not in the registry).
 */
export async function getAiUsageThisMonth(
  now: Date = new Date(),
): Promise<AiUsageSummary> {
  const organizationId = await getOrgId();
  const limits = await allAiMonthlyLimits();
  const monthStart = monthStartUtc(now);

  const { extraction, operations } = await withOrg(organizationId, async (tx) => ({
    extraction: await countExtractionUsageSince(tx, organizationId, monthStart, now),
    operations: await countOperationUsageByFeatureSince(
      tx,
      organizationId,
      monthStart,
      now,
    ),
  }));

  const rows = AI_USAGE_FEATURES.map((feature) => {
    const counts =
      feature === 'photo_recipe_extraction'
        ? extraction
        : operations.get(feature) ?? ZERO_COUNTS;
    return buildUsageRow(feature, counts, limits[feature].limit);
  });

  // Tier/source are identical across every feature (one resolved state).
  const { tier, source } = limits.photo_recipe_extraction;
  return { tier, source, resetAt: nextMonthResetUtc(now), rows };
}

/**
 * Just the photo-extraction row (the inline hint on `/recipes/import/photo`). One
 * entitlement read + one ledger read inside `withOrg`, so the page pays no cost for the
 * five operation features it does not show.
 */
export async function getPhotoExtractionUsageThisMonth(
  now: Date = new Date(),
): Promise<AiUsageRow> {
  const organizationId = await getOrgId();
  const limits = await allAiMonthlyLimits();
  const monthStart = monthStartUtc(now);
  const counts = await withOrg(organizationId, (tx) =>
    countExtractionUsageSince(tx, organizationId, monthStart, now),
  );
  return buildUsageRow(
    'photo_recipe_extraction',
    counts,
    limits.photo_recipe_extraction.limit,
  );
}

/** Photo-extraction usage + the tier/source/reset context the sidebar meter needs. */
export type PhotoExtractionUsageSummary = {
  tier: PlanTier;
  source: EntitlementSource;
  /** First instant of the next UTC month — when the counter resets. */
  resetAt: Date;
  row: AiUsageRow;
};

/**
 * Photo-extraction usage for the SIDEBAR meter (one row, plus the tier/source needed to
 * pick its CTA). Reads only the effective photo limit + the extraction ledger inside one
 * `withOrg` transaction — it deliberately never touches the five operation features, so
 * the meter costs one cheap read per navigation instead of the full billing meter.
 */
export async function getPhotoExtractionUsageSummaryThisMonth(
  now: Date = new Date(),
): Promise<PhotoExtractionUsageSummary> {
  const organizationId = await getOrgId();
  const limits = await allAiMonthlyLimits();
  const monthStart = monthStartUtc(now);
  const counts = await withOrg(organizationId, (tx) =>
    countExtractionUsageSince(tx, organizationId, monthStart, now),
  );
  const photo = limits.photo_recipe_extraction;
  return {
    tier: photo.tier,
    source: photo.source,
    resetAt: nextMonthResetUtc(now),
    row: buildUsageRow('photo_recipe_extraction', counts, photo.limit),
  };
}

/** One metered feature's slice of the sidebar meter (client-safe). */
export type SidebarAiMeterFeature = {
  feature: AiUsageFeature;
  used: number;
  limit: number;
  remaining: number;
  availableNow: number;
  /** `used / limit` clamped to 0..100 for the bar. */
  percent: number;
};

/** Serializable view for the sidebar AI-usage meter (client-safe). */
export type SidebarAiMeterView = {
  source: EntitlementSource;
  /**
   * Source-driven upsell: trial/free → `Upgrade` to `/pricing`, paid → `Manage plan` to
   * `/billing`, comped → none (no plan to buy).
   */
  cta: null | { labelKey: 'upgrade' | 'managePlan'; href: '/pricing' | '/billing' };
  /**
   * One entry per metered feature the plan actually grants (`limit > 0`), in display
   * order. Always non-empty (the builder returns `null` when there is nothing to show),
   * so the sidebar meter can page left/right through them.
   */
  features: SidebarAiMeterFeature[];
};

/**
 * Pure projection of the full {@link AiUsageSummary} into the sidebar meter view.
 * Returns `null` when the plan grants no metered allowance (every `limit <= 0`) so the
 * footer meter simply doesn't render. `percent` clamps at 100 even after a downgrade
 * left `used > limit`; the CTA follows the entitlement source.
 */
export function buildSidebarAiMeterView(
  summary: AiUsageSummary,
): SidebarAiMeterView | null {
  const visible = summary.rows.filter((row) => row.limit > 0);
  if (visible.length === 0) return null;
  const { source } = summary;
  const cta =
    source === 'comped'
      ? null
      : source === 'paid'
        ? ({ labelKey: 'managePlan', href: '/billing' } as const)
        : ({ labelKey: 'upgrade', href: '/pricing' } as const);
  return {
    source,
    cta,
    features: visible.map((row) => ({
      feature: row.feature,
      used: row.used,
      limit: row.limit,
      remaining: row.remaining,
      availableNow: row.availableNow,
      percent: Math.min(100, Math.round((row.used / row.limit) * 100)),
    })),
  };
}
