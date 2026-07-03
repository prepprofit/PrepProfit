import { and, count, eq, gte, or, sql } from 'drizzle-orm';
import { aiOperationAttempts } from '@/lib/db/schema';
import type { AiOperationAttempt } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import type { AiOperationFeature } from '@/lib/ai/operation-types';

/**
 * Data access for the GENERIC AI operation ledger (Sprint 2, AI margin roadmap).
 * ALWAYS org-scoped (RULE #1) — the org id is derived server-side, RLS
 * (lib/db/rls.ts) is the second layer.
 *
 * Mirrors `lib/data/ai-extraction.ts` (the photo path) but is keyed by `feature`, so
 * each new provider-backed feature gets consistent cost/usage tracking + a per-feature
 * monthly cap without a new table. The attempt row doubles as the USAGE METER: the
 * upload route writes a `pending` row before the provider call, flips it to
 * `succeeded`/`failed`, and {@link countReservedOperations} enforces the monthly cap —
 * all inside one `withOrg` transaction under {@link lockMonthlyOperationQuota}, so the
 * count and the new attempt can never race across the cap boundary.
 */

export type CreateOperationAttemptInput = {
  actorUserId: string;
  feature: AiOperationFeature;
  provider: string;
  model: string;
};

/** Insert a `pending` attempt and return it (written before the provider call). */
export async function createOperationAttempt(
  db: TenantClient,
  organizationId: string,
  input: CreateOperationAttemptInput,
): Promise<AiOperationAttempt> {
  const [row] = await db
    .insert(aiOperationAttempts)
    .values({
      organizationId,
      actorUserId: input.actorUserId,
      feature: input.feature,
      provider: input.provider,
      model: input.model,
      status: 'pending',
    })
    .returning();
  if (!row) throw new Error('Failed to create AI operation attempt.');
  return row;
}

export type OperationSuccessInput = {
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  qualityFlags: string[];
  /** Generic provenance pointer to what the operation produced (e.g. an import row). */
  resultType?: string | null;
  resultId?: string | null;
};

/** Flip an attempt to `succeeded`, recording usage + the produced result pointer. */
export async function markOperationSucceeded(
  db: TenantClient,
  organizationId: string,
  id: string,
  input: OperationSuccessInput,
): Promise<void> {
  await db
    .update(aiOperationAttempts)
    .set({
      status: 'succeeded',
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      costMicros: input.costMicros,
      qualityFlags: input.qualityFlags,
      resultType: input.resultType ?? null,
      resultId: input.resultId ?? null,
      errorCode: null,
    })
    .where(
      and(
        eq(aiOperationAttempts.organizationId, organizationId),
        eq(aiOperationAttempts.id, id),
      ),
    );
}

export type OperationFailureInput = {
  errorCode: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
};

/**
 * Flip an attempt to `failed` with a stable error code (never raw provider prose).
 * A failed attempt does NOT count toward the monthly cap.
 */
export async function markOperationFailed(
  db: TenantClient,
  organizationId: string,
  id: string,
  input: OperationFailureInput,
): Promise<void> {
  await db
    .update(aiOperationAttempts)
    .set({
      status: 'failed',
      errorCode: input.errorCode,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
    })
    .where(
      and(
        eq(aiOperationAttempts.organizationId, organizationId),
        eq(aiOperationAttempts.id, id),
      ),
    );
}

/**
 * Start of the calendar month containing `now`, in UTC. The monthly usage window
 * resets at this boundary. Pure so the cap math is deterministic and testable.
 */
export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * In-flight horizon for a `pending` attempt. A pending row reserves a quota slot from
 * the moment it is written until it flips to succeeded/failed; this window bounds the
 * cost of a LEAKED pending (a crash between the gate commit and the mark*), so a stuck
 * reservation stops counting toward the cap after the horizon. A real provider call
 * resolves in seconds, well inside this window.
 */
export const OPERATION_INFLIGHT_MS = 5 * 60_000;

/**
 * Serialize the monthly-cap check for one (org, feature, month) via a TRANSACTION-level
 * advisory lock. Held until the surrounding `withOrg` tx commits, so two concurrent
 * uploads for the same org+feature can no longer both read an under-limit count and
 * both reserve a slot — the cap becomes exact, not best-effort. The lock key is hashed
 * from the org id + feature + month; it is purely an in-DB mutex (no row written).
 */
export async function lockMonthlyOperationQuota(
  db: TenantClient,
  organizationId: string,
  feature: AiOperationFeature,
  monthStart: Date,
): Promise<void> {
  const key = `ai-op:${organizationId}:${feature}:${monthStart.getUTCFullYear()}-${
    monthStart.getUTCMonth() + 1
  }`;
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

/**
 * Count this org's RESERVED slots for a feature this month: every `succeeded` attempt
 * since `monthStart` PLUS every still-in-flight `pending` attempt (created within
 * {@link OPERATION_INFLIGHT_MS} of `now`). This is the value the cap is checked against
 * while holding {@link lockMonthlyOperationQuota}, so concurrent in-flight uploads count
 * toward the limit and the cap cannot overshoot. A `failed` attempt is excluded.
 */
export async function countReservedOperations(
  db: TenantClient,
  organizationId: string,
  feature: AiOperationFeature,
  monthStart: Date,
  now: Date,
): Promise<number> {
  const inFlightSince = new Date(now.getTime() - OPERATION_INFLIGHT_MS);
  const rows = await db
    .select({ value: count() })
    .from(aiOperationAttempts)
    .where(
      and(
        eq(aiOperationAttempts.organizationId, organizationId),
        eq(aiOperationAttempts.feature, feature),
        or(
          and(
            eq(aiOperationAttempts.status, 'succeeded'),
            gte(aiOperationAttempts.createdAt, monthStart),
          ),
          and(
            eq(aiOperationAttempts.status, 'pending'),
            gte(aiOperationAttempts.createdAt, inFlightSince),
          ),
        ),
      ),
    );
  return rows[0]?.value ?? 0;
}

/**
 * Combined USAGE-METER counts for the current month, grouped by feature in ONE query:
 * per feature, `used` (billed — `succeeded` since `monthStart`) and `reserved` (`used`
 * PLUS still-in-flight `pending`). Returned as a `Map` keyed by feature so the meter can
 * render one row per metered operation feature without a query each. Rows with neither a
 * succeeded-this-month nor a fresh-pending attempt are absent — callers default missing
 * features to `{ used: 0, reserved: 0 }`. This is the DISPLAY read (no advisory lock), so
 * it must NOT authorize a call; {@link countReservedOperations} under
 * {@link lockMonthlyOperationQuota} stays the cap authority. Org-scoped; RLS second layer.
 */
export async function countOperationUsageByFeatureSince(
  db: TenantClient,
  organizationId: string,
  monthStart: Date,
  now: Date,
): Promise<Map<AiOperationFeature, { used: number; reserved: number }>> {
  const inFlightSince = new Date(now.getTime() - OPERATION_INFLIGHT_MS);
  const succeededThisMonth = and(
    eq(aiOperationAttempts.status, 'succeeded'),
    gte(aiOperationAttempts.createdAt, monthStart),
  );
  const freshPending = and(
    eq(aiOperationAttempts.status, 'pending'),
    gte(aiOperationAttempts.createdAt, inFlightSince),
  );
  const rows = await db
    .select({
      feature: aiOperationAttempts.feature,
      used: sql<number>`count(*) filter (where ${succeededThisMonth})`,
      reserved: sql<number>`count(*) filter (where ${succeededThisMonth} or ${freshPending})`,
    })
    .from(aiOperationAttempts)
    .where(
      and(
        eq(aiOperationAttempts.organizationId, organizationId),
        or(succeededThisMonth, freshPending),
      ),
    )
    .groupBy(aiOperationAttempts.feature);

  const usage = new Map<AiOperationFeature, { used: number; reserved: number }>();
  for (const row of rows) {
    usage.set(row.feature, {
      used: Number(row.used ?? 0),
      reserved: Number(row.reserved ?? 0),
    });
  }
  return usage;
}

/**
 * Count this org's `succeeded` attempts for a feature since `since` (the billed-usage
 * figure, e.g. for a usage display). Org-scoped; RLS is the second layer. NOTE: the
 * monthly CAP is enforced with {@link countReservedOperations} under
 * {@link lockMonthlyOperationQuota} — this succeeded-only count is not race-safe for
 * gating on its own.
 */
export async function countSucceededOperationsSince(
  db: TenantClient,
  organizationId: string,
  feature: AiOperationFeature,
  since: Date,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(aiOperationAttempts)
    .where(
      and(
        eq(aiOperationAttempts.organizationId, organizationId),
        eq(aiOperationAttempts.feature, feature),
        eq(aiOperationAttempts.status, 'succeeded'),
        gte(aiOperationAttempts.createdAt, since),
      ),
    );
  return rows[0]?.value ?? 0;
}
