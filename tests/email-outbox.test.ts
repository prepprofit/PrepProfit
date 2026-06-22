import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { emailOutbox } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  cancelPendingOutbox,
  claimDueOutbox,
  enqueueEmail,
  markOutboxFailed,
  markOutboxSent,
} from '@/lib/data/email-outbox';

/**
 * Email outbox (Sprint 8a) under the `tenant_app` role. Proves the at-least-once
 * lease queue: idempotent enqueue, lease-stamping claim, sent sets the provider id
 * (blocking resend), failure backoff + exhaustion, expired-lease reclaim, and
 * cancellation of an un-sent row.
 */
const ORG = 'org_outbox';

let client: PGlite;
let db: TenantDb;

const enqueue = (documentId: string, dedupKey: string, toEmail = 'a@b.test') =>
  runInOrg(db, ORG, (tx) =>
    enqueueEmail(tx, ORG, {
      documentType: 'purchase_order',
      documentId,
      toEmail,
      subject: null,
      dedupKey,
    }),
  );

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  await db.execute(sql.raw('SET ROLE tenant_app;'));
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

describe('enqueueEmail', () => {
  it('is idempotent on (org, dedup_key)', async () => {
    const first = await enqueue('po1', 'purchase_order:po1:send');
    expect(first).not.toBeNull();
    const second = await enqueue('po1', 'purchase_order:po1:send');
    expect(second).toBeNull();

    const rows = await runInOrg(db, ORG, (tx) =>
      tx.select().from(emailOutbox).where(eq(emailOutbox.documentId, 'po1')),
    );
    expect(rows).toHaveLength(1);
  });
});

describe('claim + deliver', () => {
  it('claims a due row with a lease, then markOutboxSent blocks any resend', async () => {
    await enqueue('po2', 'purchase_order:po2:send');
    const now = new Date(Date.now() + 1000);

    const claimed = await runInOrg(db, ORG, (tx) =>
      claimDueOutbox(tx, ORG, now, 'tok-1', 10),
    );
    const row = claimed.find((r) => r.documentId === 'po2');
    expect(row).toBeDefined();
    expect(row?.status).toBe('sending');
    expect(row?.claimToken).toBe('tok-1');
    expect(row?.leaseUntil).not.toBeNull();

    const owned = await runInOrg(db, ORG, (tx) =>
      markOutboxSent(tx, ORG, row!.id, 'tok-1', 'provider-msg-123'),
    );
    expect(owned).toBe(true);

    // A row that already has a provider_message_id is never claimed again.
    const reclaim = await runInOrg(db, ORG, (tx) =>
      claimDueOutbox(tx, ORG, new Date(Date.now() + 10_000), 'tok-2', 10),
    );
    expect(reclaim.find((r) => r.documentId === 'po2')).toBeUndefined();

    const sent = await runInOrg(db, ORG, (tx) =>
      tx.select().from(emailOutbox).where(eq(emailOutbox.documentId, 'po2')),
    );
    expect(sent[0]?.status).toBe('sent');
    expect(sent[0]?.providerMessageId).toBe('provider-msg-123');
  });
});

describe('failure backoff + exhaustion', () => {
  it('a non-final failure returns to pending with a future next_attempt_at', async () => {
    await enqueue('po3', 'purchase_order:po3:send');
    const now = new Date(Date.now() + 1000);
    const claimed = await runInOrg(db, ORG, (tx) =>
      claimDueOutbox(tx, ORG, now, 'tok-f1', 10),
    );
    const row = claimed.find((r) => r.documentId === 'po3')!;

    const updated = await runInOrg(db, ORG, (tx) =>
      markOutboxFailed(tx, ORG, row, 'tok-f1', 'smtp down', now),
    );
    expect(updated).toBe(true);

    const after = await runInOrg(db, ORG, (tx) =>
      tx.select().from(emailOutbox).where(eq(emailOutbox.documentId, 'po3')),
    );
    expect(after[0]?.status).toBe('pending');
    expect(after[0]?.attempts).toBe(1);
    expect(after[0]?.lastError).toBe('smtp down');
    expect(new Date(after[0]!.nextAttemptAt).getTime()).toBeGreaterThan(now.getTime());
  });

  it('reaching max_attempts marks the row failed (terminal)', async () => {
    await enqueue('po4', 'purchase_order:po4:send');
    // Force it to the brink so the next failure is terminal.
    await runInOrg(db, ORG, (tx) =>
      tx
        .update(emailOutbox)
        .set({ attempts: 4, maxAttempts: 5 })
        .where(eq(emailOutbox.documentId, 'po4')),
    );
    const now = new Date(Date.now() + 1000);
    const claimed = await runInOrg(db, ORG, (tx) =>
      claimDueOutbox(tx, ORG, now, 'tok-f2', 10),
    );
    const row = claimed.find((r) => r.documentId === 'po4')!;
    await runInOrg(db, ORG, (tx) =>
      markOutboxFailed(tx, ORG, row, 'tok-f2', 'gave up', now),
    );

    const after = await runInOrg(db, ORG, (tx) =>
      tx.select().from(emailOutbox).where(eq(emailOutbox.documentId, 'po4')),
    );
    expect(after[0]?.status).toBe('failed');
    expect(after[0]?.attempts).toBe(5);
  });
});

describe('crash recovery', () => {
  it('an expired-lease sending row is reclaimable', async () => {
    await enqueue('po5', 'purchase_order:po5:send');
    const t0 = new Date(Date.now() + 1000);
    // Claim with a short lease.
    const first = await runInOrg(db, ORG, (tx) =>
      claimDueOutbox(tx, ORG, t0, 'tok-c1', 10, 1000),
    );
    expect(first.find((r) => r.documentId === 'po5')).toBeDefined();

    // Worker "crashes" — never records a result. After the lease expires, another
    // worker reclaims it.
    const later = new Date(t0.getTime() + 5000);
    const second = await runInOrg(db, ORG, (tx) =>
      claimDueOutbox(tx, ORG, later, 'tok-c2', 10),
    );
    const reclaimed = second.find((r) => r.documentId === 'po5');
    expect(reclaimed).toBeDefined();
    expect(reclaimed?.claimToken).toBe('tok-c2');
  });
});

describe('cancelPendingOutbox', () => {
  it('cancels an un-sent row but leaves a sent one alone', async () => {
    await enqueue('po6', 'purchase_order:po6:send');
    const cancelled = await runInOrg(db, ORG, (tx) =>
      cancelPendingOutbox(tx, ORG, 'purchase_order', 'po6'),
    );
    expect(cancelled).toBe(1);

    const after = await runInOrg(db, ORG, (tx) =>
      tx.select().from(emailOutbox).where(eq(emailOutbox.documentId, 'po6')),
    );
    expect(after[0]?.status).toBe('cancelled');

    // A row that already left (provider id set) is NOT cancelled.
    await enqueue('po7', 'purchase_order:po7:send');
    await runInOrg(db, ORG, (tx) =>
      tx
        .update(emailOutbox)
        .set({ status: 'sent', providerMessageId: 'm1' })
        .where(eq(emailOutbox.documentId, 'po7')),
    );
    const none = await runInOrg(db, ORG, (tx) =>
      cancelPendingOutbox(tx, ORG, 'purchase_order', 'po7'),
    );
    expect(none).toBe(0);
  });
});
