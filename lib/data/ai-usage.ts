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
import { logError } from '@/lib/observability';

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
 * One import method's allowance for the import workflow (client-safe: plain values, the
 * reset instant as an ISO string). DISPLAY only — the upload routes remain the cap
 * authority. `availableNow` (limit − used − in-flight) is what the "can I start one
 * right now?" copy uses, so it never promises a slot that is already reserved.
 */
export type ImportAllowance = {
  feature: ImportAllowanceFeature;
  used: number;
  limit: number;
  availableNow: number;
  /** ISO instant of the next UTC month start — when the counter resets. */
  resetAt: string;
};

/** The AI-assisted import methods that carry their own monthly allowance. */
export const IMPORT_ALLOWANCE_FEATURES = [
  'photo_recipe_extraction',
  'supplier_invoice_extraction',
] as const;
export type ImportAllowanceFeature = (typeof IMPORT_ALLOWANCE_FEATURES)[number];

/**
 * Pure projection of the full meter into per-import-method allowances. A method whose
 * row is missing yields `null` ("unknown") — callers must render that as unavailable,
 * never as zero used or unlimited.
 */
export function buildImportAllowances(
  summary: AiUsageSummary,
): Record<ImportAllowanceFeature, ImportAllowance | null> {
  const pick = (feature: ImportAllowanceFeature): ImportAllowance | null => {
    const row = summary.rows.find((r) => r.feature === feature);
    if (!row) return null;
    return {
      feature,
      used: row.used,
      limit: row.limit,
      availableNow: row.availableNow,
      resetAt: summary.resetAt.toISOString(),
    };
  };
  return {
    photo_recipe_extraction: pick('photo_recipe_extraction'),
    supplier_invoice_extraction: pick('supplier_invoice_extraction'),
  };
}

/**
 * Allowances for the import workflow (the /import page and each AI import page). One
 * entitlement read + both ledger reads, org-scoped through `getAiUsageThisMonth`. If the
 * read fails the error is logged and every method comes back `null` (unavailable) — the
 * page still renders, and server-side limit enforcement is unaffected.
 */
export async function getImportAllowances(
  now: Date = new Date(),
): Promise<Record<ImportAllowanceFeature, ImportAllowance | null>> {
  try {
    return buildImportAllowances(await getAiUsageThisMonth(now));
  } catch (err) {
    logError({ action: 'getImportAllowances' }, err);
    return { photo_recipe_extraction: null, supplier_invoice_extraction: null };
  }
}
