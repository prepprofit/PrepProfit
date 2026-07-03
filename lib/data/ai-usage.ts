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
