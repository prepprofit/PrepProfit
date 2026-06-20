import { and, count, eq, gte } from 'drizzle-orm';
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
  importJobId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  qualityFlags: AiQualityFlag[];
};

/** Flip an attempt to `succeeded`, linking the staged job + recording usage. */
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
 * Count this org's `succeeded` attempts since `since` (the month start) — the value
 * the monthly cap is checked against. Org-scoped; RLS is the second layer.
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
