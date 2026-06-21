import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { poCounters } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { advancePoCounterAtLeast, allocatePoNumber } from '@/lib/data/po-counters';

/**
 * Sprint F6 — PO reference counter, against a real in-memory Postgres (PGlite)
 * under the non-privileged `tenant_app` role so RLS + the CHECK are enforced.
 * (Real concurrency is proven separately in tests/concurrency/po-counter.pg.test.ts
 * — PGlite is a single connection and can't race transactions.)
 */
const ORG_A = 'org_po_a';
const ORG_B = 'org_po_b';

let client: PGlite;
let db: TenantDb;

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

describe('allocatePoNumber', () => {
  it('hands out a monotonic per-org sequence starting at 1', async () => {
    const a1 = await runInOrg(db, ORG_A, (tx) => allocatePoNumber(tx, ORG_A));
    const a2 = await runInOrg(db, ORG_A, (tx) => allocatePoNumber(tx, ORG_A));
    const a3 = await runInOrg(db, ORG_A, (tx) => allocatePoNumber(tx, ORG_A));
    expect([a1, a2, a3]).toEqual([1, 2, 3]);
  });

  it('keeps org sequences independent', async () => {
    const b1 = await runInOrg(db, ORG_B, (tx) => allocatePoNumber(tx, ORG_B));
    expect(b1).toBe(1); // ORG_B starts fresh, unaffected by ORG_A
  });
});

describe('advancePoCounterAtLeast', () => {
  it('jumps the counter forward so an edited number is never re-issued', async () => {
    // ORG_A is at 3 from above; a manual edit to 500 must push it to >= 500.
    await runInOrg(db, ORG_A, (tx) => advancePoCounterAtLeast(tx, ORG_A, 500));
    const next = await runInOrg(db, ORG_A, (tx) => allocatePoNumber(tx, ORG_A));
    expect(next).toBe(501);
  });

  it('never moves the counter backwards', async () => {
    // Counter is at 501; advancing to a lower value is a no-op.
    await runInOrg(db, ORG_A, (tx) => advancePoCounterAtLeast(tx, ORG_A, 10));
    const next = await runInOrg(db, ORG_A, (tx) => allocatePoNumber(tx, ORG_A));
    expect(next).toBe(502);
  });

  it('rejects a non-positive number', async () => {
    await expect(
      runInOrg(db, ORG_A, (tx) => advancePoCounterAtLeast(tx, ORG_A, 0)),
    ).rejects.toThrow();
  });
});

describe('CHECK (last_seq >= 0)', () => {
  it('rejects a direct negative write', async () => {
    await expect(
      runInOrg(db, 'org_po_chk', (tx) =>
        tx.insert(poCounters).values({ organizationId: 'org_po_chk', lastSeq: -1 }),
      ),
    ).rejects.toThrow();
  });
});

describe('RLS — cross-org access is blocked', () => {
  it('cannot read or write another org counter from inside this org context', async () => {
    // Seed ORG_B's counter in its own context.
    await runInOrg(db, ORG_B, (tx) => allocatePoNumber(tx, ORG_B));

    await runInOrg(db, ORG_A, async (tx) => {
      // A SELECT for ORG_B from ORG_A's context sees nothing (org_isolation).
      const rows = await tx
        .select()
        .from(poCounters)
        .where(
          and(
            eq(poCounters.organizationId, ORG_B),
            // belt-and-suspenders; RLS already hides the row
          ),
        );
      expect(rows).toHaveLength(0);
    });

    // Allocating for ORG_B from ORG_A's context is refused by the WITH CHECK policy.
    await expect(
      runInOrg(db, ORG_A, (tx) => allocatePoNumber(tx, ORG_B)),
    ).rejects.toThrow();
  });
});
