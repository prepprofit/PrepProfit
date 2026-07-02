import { and, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { emailOutbox } from '@/lib/db/schema';
import type { EmailOutboxRow } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';

/**
 * Outbound email queue (Sprint 8a). A lease-based work queue: the send action
 * enqueues one row in its `withOrg` tx, and the cron worker claims + delivers it
 * with backoff. Semantics are AT-LEAST-ONCE with provider-side dedup (the worker
 * passes `dedupKey` to Resend as an idempotency key), NOT exactly-once. Always
 * org-scoped (RULE #1) and run inside `withOrg`.
 */

/** Default claim lease and retry backoff (worker-tunable via args). */
export const OUTBOX_LEASE_MS = 60_000;
const BACKOFF_BASE_MS = 60_000;

export type EnqueueEmailInput = {
  /** Widened for the weekly CFO digest (React Email migration); PO remains the other type. */
  documentType: 'purchase_order' | 'cfo_report';
  /** For `cfo_report`, this is the week-ending 'YYYY-MM-DD' (no PO row exists). */
  documentId: string;
  toEmail: string;
  subject: string | null;
  dedupKey: string;
};

/**
 * Idempotent enqueue: one row per (org, dedup_key). A second enqueue with the same
 * key is a no-op (returns the existing row's absence as `null`), so a retried send
 * never queues a duplicate email. MUST run inside the send's `withOrg` tx.
 */
export async function enqueueEmail(
  db: TenantClient,
  organizationId: string,
  input: EnqueueEmailInput,
): Promise<EmailOutboxRow | null> {
  const [row] = await db
    .insert(emailOutbox)
    .values({
      organizationId,
      documentType: input.documentType,
      documentId: input.documentId,
      toEmail: input.toEmail,
      subject: input.subject,
      dedupKey: input.dedupKey,
    })
    .onConflictDoNothing({
      target: [emailOutbox.organizationId, emailOutbox.dedupKey],
    })
    .returning();
  return row ?? null;
}

/**
 * Atomically CLAIM up to `limit` due rows for this worker. Uses
 * `SELECT … FOR UPDATE SKIP LOCKED` so two concurrent workers never grab the same
 * row, then stamps a lease + claim token. A row is due when it is unsent
 * (`provider_message_id IS NULL`) AND either pending-and-past-its-next-attempt OR a
 * `sending` row whose lease expired (crash recovery). MUST run inside `withOrg`.
 */
export async function claimDueOutbox(
  db: TenantClient,
  organizationId: string,
  now: Date,
  claimToken: string,
  limit: number,
  leaseMs: number = OUTBOX_LEASE_MS,
): Promise<EmailOutboxRow[]> {
  const due = await db
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.organizationId, organizationId),
        isNull(emailOutbox.providerMessageId),
        or(
          and(
            eq(emailOutbox.status, 'pending'),
            lte(emailOutbox.nextAttemptAt, now),
          ),
          and(
            eq(emailOutbox.status, 'sending'),
            lt(emailOutbox.leaseUntil, now),
          ),
        ),
      ),
    )
    .orderBy(emailOutbox.nextAttemptAt)
    .limit(limit)
    .for('update', { skipLocked: true });

  const ids = due.map((r) => r.id);
  if (ids.length === 0) return [];

  const leaseUntil = new Date(now.getTime() + leaseMs);
  return db
    .update(emailOutbox)
    .set({ status: 'sending', leaseUntil, claimToken })
    .where(
      and(
        eq(emailOutbox.organizationId, organizationId),
        inArray(emailOutbox.id, ids),
      ),
    )
    .returning();
}

/**
 * Record a successful delivery: set the provider message id (which permanently
 * blocks any resend) and mark `sent`. Guarded by `claimToken` so a stale worker
 * whose lease expired (and whose row another worker re-claimed) cannot overwrite
 * the new claim. Returns true if this worker still owned the row.
 */
export async function markOutboxSent(
  db: TenantClient,
  organizationId: string,
  id: string,
  claimToken: string,
  providerMessageId: string,
): Promise<boolean> {
  const [row] = await db
    .update(emailOutbox)
    .set({
      status: 'sent',
      providerMessageId,
      lastError: null,
      leaseUntil: null,
      claimToken: null,
    })
    .where(
      and(
        eq(emailOutbox.organizationId, organizationId),
        eq(emailOutbox.id, id),
        eq(emailOutbox.claimToken, claimToken),
        isNull(emailOutbox.providerMessageId),
      ),
    )
    .returning({ id: emailOutbox.id });
  return Boolean(row);
}

/**
 * Record a failed attempt under exponential backoff. Increments `attempts`; once it
 * reaches `max_attempts` the row is terminal `failed`, otherwise it returns to
 * `pending` with a future `next_attempt_at`. Guarded by `claimToken` (see
 * {@link markOutboxSent}). The next delay is `BACKOFF_BASE_MS × 2^(attempts-1)`.
 */
export async function markOutboxFailed(
  db: TenantClient,
  organizationId: string,
  row: Pick<EmailOutboxRow, 'id' | 'attempts' | 'maxAttempts'>,
  claimToken: string,
  errorMessage: string,
  now: Date,
): Promise<boolean> {
  const attempts = row.attempts + 1;
  const exhausted = attempts >= row.maxAttempts;
  const delay = BACKOFF_BASE_MS * 2 ** (attempts - 1);
  const [updated] = await db
    .update(emailOutbox)
    .set({
      status: exhausted ? 'failed' : 'pending',
      attempts,
      lastError: errorMessage.slice(0, 1000),
      nextAttemptAt: new Date(now.getTime() + delay),
      leaseUntil: null,
      claimToken: null,
    })
    .where(
      and(
        eq(emailOutbox.organizationId, organizationId),
        eq(emailOutbox.id, row.id),
        eq(emailOutbox.claimToken, claimToken),
        isNull(emailOutbox.providerMessageId),
      ),
    )
    .returning({ id: emailOutbox.id });
  return Boolean(updated);
}

/**
 * Terminally CANCEL a single claimed row (React Email migration). Used by the CFO
 * delivery path when, at send time, the org has opted out of the weekly report or
 * cleared its business email — there is nothing to deliver, and this is NOT a
 * failure to retry. Guarded by `claimToken` (like {@link markOutboxSent}) so a stale
 * worker cannot cancel a row another worker re-claimed, and by the unsent guard so a
 * row that already sent is never touched. Returns true if this worker still owned it.
 */
export async function markOutboxCancelled(
  db: TenantClient,
  organizationId: string,
  id: string,
  claimToken: string,
): Promise<boolean> {
  const [row] = await db
    .update(emailOutbox)
    .set({ status: 'cancelled', leaseUntil: null, claimToken: null })
    .where(
      and(
        eq(emailOutbox.organizationId, organizationId),
        eq(emailOutbox.id, id),
        eq(emailOutbox.claimToken, claimToken),
        isNull(emailOutbox.providerMessageId),
      ),
    )
    .returning({ id: emailOutbox.id });
  return Boolean(row);
}

/**
 * Cancel any un-sent outbox rows for a document (used when a PO is cancelled before
 * its send email left). A row that already has `provider_message_id` is left alone —
 * the email is gone, so the caller enqueues a separate cancellation notice instead.
 * Returns how many rows were cancelled.
 */
export async function cancelPendingOutbox(
  db: TenantClient,
  organizationId: string,
  documentType: 'purchase_order',
  documentId: string,
): Promise<number> {
  const cancelled = await db
    .update(emailOutbox)
    .set({ status: 'cancelled', leaseUntil: null, claimToken: null })
    .where(
      and(
        eq(emailOutbox.organizationId, organizationId),
        eq(emailOutbox.documentType, documentType),
        eq(emailOutbox.documentId, documentId),
        isNull(emailOutbox.providerMessageId),
        sql`${emailOutbox.status} in ('pending', 'sending')`,
      ),
    )
    .returning({ id: emailOutbox.id });
  return cancelled.length;
}

/** The outbox rows for a document, newest first — for the UI status chip. */
export async function listOutboxForDocument(
  db: TenantClient,
  organizationId: string,
  documentType: 'purchase_order',
  documentId: string,
): Promise<EmailOutboxRow[]> {
  return db
    .select()
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.organizationId, organizationId),
        eq(emailOutbox.documentType, documentType),
        eq(emailOutbox.documentId, documentId),
      ),
    )
    .orderBy(sql`${emailOutbox.createdAt} desc`);
}
