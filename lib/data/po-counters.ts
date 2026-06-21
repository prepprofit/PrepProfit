import { sql } from 'drizzle-orm';
import { poCounters } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';

/**
 * Purchase-order reference numbering (Sprint F6). One counter row per org holding
 * the LAST number handed out (`last_seq`), mirroring `invoice_counters`. Always
 * org-scoped (RULE #1); RLS is the second layer.
 *
 * UNLIKE invoices, PO numbers are gap-TOLERANT and editable — the counter only
 * yields the suggested default. The real `purchase_orders.number` (Sprint 8a) is an
 * editable, `unique (org, number)`, positive-integer column. The consuming sprint
 * MUST call {@link allocatePoNumber} inside the SAME `withOrg` transaction that
 * inserts the PO (never on form open), and call {@link advancePoCounterAtLeast}
 * when a number is manually edited so the counter never re-issues it.
 */

/**
 * Atomically allocate the next PO number for an org and return it. A single
 * upsert-increment: it row-locks the counter (serializing concurrent allocations)
 * and commits with the surrounding transaction. First call → 1, then 2, 3…
 *
 * Numbers are gap-tolerant: a rolled-back transaction releases the number, and a
 * later deleted/edited PO leaves a gap — both accepted. Must run inside the
 * `withOrg` transaction that creates the PO.
 */
export async function allocatePoNumber(
  db: TenantClient,
  organizationId: string,
): Promise<number> {
  const [row] = await db
    .insert(poCounters)
    .values({ organizationId, lastSeq: 1 })
    .onConflictDoUpdate({
      target: poCounters.organizationId,
      set: { lastSeq: sql`${poCounters.lastSeq} + 1` },
    })
    .returning({ lastSeq: poCounters.lastSeq });
  if (!row) throw new Error('Failed to allocate PO number.');
  return row.lastSeq;
}

/**
 * Move the counter forward to AT LEAST `number`, never backwards. Sprint 8a calls
 * this after a manual PO-number edit (e.g. 10 → 500) so the next allocation is
 * ≥ 501 and the edited number is never re-issued. `GREATEST` keeps it monotonic, so
 * passing a value below the current `last_seq` is a no-op.
 *
 * `number` must be a positive integer (the same rule the `purchase_orders.number`
 * column enforces in 8a). Must run inside the edit's `withOrg` transaction.
 */
export async function advancePoCounterAtLeast(
  db: TenantClient,
  organizationId: string,
  number: number,
): Promise<void> {
  if (!Number.isInteger(number) || number < 1) {
    throw new Error('advancePoCounterAtLeast: number must be a positive integer.');
  }
  await db
    .insert(poCounters)
    .values({ organizationId, lastSeq: number })
    .onConflictDoUpdate({
      target: poCounters.organizationId,
      set: {
        lastSeq: sql`greatest(${poCounters.lastSeq}, ${number})`,
      },
    });
}
