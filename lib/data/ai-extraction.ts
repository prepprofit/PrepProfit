import { and, count, eq, gte, isNull, or, sql } from 'drizzle-orm';
import { aiExtractionAttempts } from '@/lib/db/schema';
import type { AiExtractionAttempt } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import type { AiQualityFlag } from '@/lib/ai/types';

/**
 * Data access for AI extraction attempts (Sprint 4.7). ALWAYS org-scoped (RULE #1)
 * — the org id is derived server-side, RLS (lib/db/rls.ts) is the second layer.
 *
 * The attempt row doubles as the USAGE METER: the extract action writes a `pending`
 * row before calling the provider, flips it to `succeeded` (with the staged job id)
 * or `failed`, and {@link countSucceededAttemptsSince} enforces the monthly cap —
 * all inside the one `withOrg` transaction, so the count and the new attempt can
 * never race across the cap boundary. Only `succeeded` rows count toward the cap.
 */

export type CreateAttemptInput = {
  actorUserId: string;
  provider: string;
  model: string;
  imageCount: number;
};

/** Insert a `pending` attempt and return it (written before the provider call). */
export async function createExtractionAttempt(
  db: TenantClient,
  organizationId: string,
  input: CreateAttemptInput,
): Promise<AiExtractionAttempt> {
  const [row] = await db
    .insert(aiExtractionAttempts)
    .values({
      organizationId,
      actorUserId: input.actorUserId,
      provider: input.provider,
      model: input.model,
      status: 'pending',
      imageCount: input.imageCount,
    })
    .returning();
  if (!row) throw new Error('Failed to create AI extraction attempt.');
  return row;
}

export type AttemptSuccessInput = {
  /**
   * The staged job this attempt produced, or NULL when the provider succeeded but the
   * user has not staged the (editable) draft yet (improvement plan §4.3). A
   * provider-successful attempt counts toward the monthly cap whether or not it is
   * eventually staged — the provider cost was already spent. The link is filled in
   * later by {@link linkAttemptToImportJob} when the draft is staged.
   */
  importJobId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  qualityFlags: AiQualityFlag[];
};

/** Flip an attempt to `succeeded`, recording usage (and the staged job, if any). */
export async function markAttemptSucceeded(
  db: TenantClient,
  organizationId: string,
  id: string,
  input: AttemptSuccessInput,
): Promise<void> {
  await db
    .update(aiExtractionAttempts)
    .set({
      status: 'succeeded',
      importJobId: input.importJobId,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      costMicros: input.costMicros,
      qualityFlags: input.qualityFlags,
      errorCode: null,
    })
    .where(
      and(
        eq(aiExtractionAttempts.organizationId, organizationId),
        eq(aiExtractionAttempts.id, id),
      ),
    );
}

/** Read one attempt by id (org-scoped; RLS is the second layer). Null when absent. */
export async function getExtractionAttempt(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<AiExtractionAttempt | null> {
  const rows = await db
    .select()
    .from(aiExtractionAttempts)
    .where(
      and(
        eq(aiExtractionAttempts.organizationId, organizationId),
        eq(aiExtractionAttempts.id, id),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Link a succeeded attempt to the import job staged from its (edited) draft (§4.2).
 * Only an attempt that has not yet been staged (`import_job_id IS NULL`) is updated,
 * so a draft cannot be staged twice onto one attempt. Returns whether a row matched.
 */
export async function linkAttemptToImportJob(
  db: TenantClient,
  organizationId: string,
  id: string,
  importJobId: string,
): Promise<boolean> {
  const rows = await db
    .update(aiExtractionAttempts)
    .set({ importJobId })
    .where(
      and(
        eq(aiExtractionAttempts.organizationId, organizationId),
        eq(aiExtractionAttempts.id, id),
        eq(aiExtractionAttempts.status, 'succeeded'),
        isNull(aiExtractionAttempts.importJobId),
      ),
    )
    .returning({ id: aiExtractionAttempts.id });
  return rows.length > 0;
}

export type AttemptFailureInput = {
  errorCode: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
};

/**
 * Flip an attempt to `failed` with a stable error code (never raw provider prose).
 * A failed attempt keeps no job link and does NOT count toward the monthly cap.
 */
export async function markAttemptFailed(
  db: TenantClient,
  organizationId: string,
  id: string,
  input: AttemptFailureInput,
): Promise<void> {
  await db
    .update(aiExtractionAttempts)
    .set({
      status: 'failed',
      errorCode: input.errorCode,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
    })
    .where(
      and(
        eq(aiExtractionAttempts.organizationId, organizationId),
        eq(aiExtractionAttempts.id, id),
      ),
    );
}

/**
 * Start of the calendar month containing `now`, in UTC. The monthly usage window
 * (D4) resets at this boundary. Pure so the cap math is deterministic and testable.
 */
export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Count this org's `succeeded` attempts since `since` (the month start) — the
 * billed-usage figure (e.g. for the usage display). Org-scoped; RLS is the second
 * layer. NOTE: the monthly CAP is enforced with {@link countReservedAttempts} under
 * {@link lockMonthlyExtractionQuota}, which also counts in-flight `pending` slots so
 * concurrent uploads cannot overshoot — this succeeded-only count is not race-safe
 * for gating on its own.
 */
export async function countSucceededAttemptsSince(
  db: TenantClient,
  organizationId: string,
  since: Date,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(aiExtractionAttempts)
    .where(
      and(
        eq(aiExtractionAttempts.organizationId, organizationId),
        eq(aiExtractionAttempts.status, 'succeeded'),
        gte(aiExtractionAttempts.createdAt, since),
      ),
    );
  return rows[0]?.value ?? 0;
}

/** Aggregated provider spend for one org over a window — the weekly-report figures. */
export type ExtractionCostSummary = {
  /** Number of `succeeded` extractions in the window. */
  count: number;
  /** Summed reported input/output tokens (0 when none reported). */
  inputTokens: number;
  outputTokens: number;
  /** Summed estimated provider cost in micros of USD (0 when none estimated). */
  costMicros: number;
};

/**
 * Sum this org's `succeeded` extractions since `since`: attempt count, total tokens,
 * and total estimated provider cost (micros of USD). Org-scoped (RULE #1); RLS is the
 * second layer. The operator cost report (cron) calls this once PER org inside
 * `withOrg` and adds the per-org totals — there is no cross-tenant query. NULL sums
 * (no rows / unreported usage) coalesce to 0.
 */
export async function sumExtractionCostSince(
  db: TenantClient,
  organizationId: string,
  since: Date,
): Promise<ExtractionCostSummary> {
  const rows = await db
    .select({
      count: count(),
      inputTokens: sql<number>`coalesce(sum(${aiExtractionAttempts.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${aiExtractionAttempts.outputTokens}), 0)`,
      costMicros: sql<number>`coalesce(sum(${aiExtractionAttempts.costMicros}), 0)`,
    })
    .from(aiExtractionAttempts)
    .where(
      and(
        eq(aiExtractionAttempts.organizationId, organizationId),
        eq(aiExtractionAttempts.status, 'succeeded'),
        gte(aiExtractionAttempts.createdAt, since),
      ),
    );
  const row = rows[0];
  return {
    count: Number(row?.count ?? 0),
    inputTokens: Number(row?.inputTokens ?? 0),
    outputTokens: Number(row?.outputTokens ?? 0),
    costMicros: Number(row?.costMicros ?? 0),
  };
}

/**
 * In-flight horizon for a `pending` attempt (F-02). A pending row reserves a quota
 * slot from the moment it is written until it flips to succeeded/failed; this window
 * bounds the cost of a LEAKED pending (a crash between the gate commit and the
 * mark*), so a stuck reservation stops counting toward the cap after the horizon
 * instead of holding a slot for the rest of the month. A real provider call resolves
 * in seconds, well inside this window.
 */
export const EXTRACTION_INFLIGHT_MS = 5 * 60_000;

/**
 * Serialize the monthly-cap check for one (org, month) via a TRANSACTION-level
 * advisory lock (F-02). Held until the surrounding `withOrg` tx commits, so two
 * concurrent uploads for the same org can no longer both read an under-limit count
 * and both reserve a slot — the cap becomes exact, not best-effort. The lock key is
 * hashed from the org id + month; it is purely an in-DB mutex (no row written).
 */
export async function lockMonthlyExtractionQuota(
  db: TenantClient,
  organizationId: string,
  monthStart: Date,
): Promise<void> {
  const key = `ai-extract:${organizationId}:${monthStart.getUTCFullYear()}-${
    monthStart.getUTCMonth() + 1
  }`;
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

/**
 * Count this org's RESERVED extraction slots for the current month: every
 * `succeeded` attempt since `monthStart` PLUS every still-in-flight `pending`
 * attempt (created within {@link EXTRACTION_INFLIGHT_MS} of `now`). This is the value
 * the cap is checked against while holding {@link lockMonthlyExtractionQuota}, so
 * concurrent in-flight uploads count toward the limit and the cap cannot overshoot.
 * A `failed` attempt is excluded — it has released its slot.
 */
export async function countReservedAttempts(
  db: TenantClient,
  organizationId: string,
  monthStart: Date,
  now: Date,
): Promise<number> {
  const inFlightSince = new Date(now.getTime() - EXTRACTION_INFLIGHT_MS);
  const rows = await db
    .select({ value: count() })
    .from(aiExtractionAttempts)
    .where(
      and(
        eq(aiExtractionAttempts.organizationId, organizationId),
        or(
          and(
            eq(aiExtractionAttempts.status, 'succeeded'),
            gte(aiExtractionAttempts.createdAt, monthStart),
          ),
          and(
            eq(aiExtractionAttempts.status, 'pending'),
            gte(aiExtractionAttempts.createdAt, inFlightSince),
          ),
        ),
      ),
    );
  return rows[0]?.value ?? 0;
}
