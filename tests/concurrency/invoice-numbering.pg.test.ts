import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '@/lib/db/schema';
import { invoiceCounters } from '@/lib/db/schema';
import { runInOrg, type TenantDb } from '@/lib/db/tenant';
import { allocateInvoiceNumber } from '@/lib/data/invoices';

/**
 * REAL-Postgres concurrency proof for invoice numbering (audit F-03) — the fiscal
 * gap-free / race-proof invariant.
 *
 * Why opt-in (mirrors po-counter.pg.test.ts): the in-suite test runs on PGlite, a
 * SINGLE in-process connection, so it cannot run two transactions concurrently and
 * therefore cannot exercise the row-lock that serializes concurrent allocations —
 * the exact property `allocateInvoiceNumber`'s atomic upsert-increment guarantees.
 *
 * Setup: point `TEST_DATABASE_URL` at a DISPOSABLE Neon branch with migrations +
 * RLS already applied (`DATABASE_URL=<branch> npm run db:migrate`). Without the env
 * var the whole describe is skipped (CI stays green with no database).
 *
 * The invariant under test: K concurrent allocations for one (org, year) return K
 * DISTINCT, CONTIGUOUS numbers (no collision, no lost update, no gap) and the
 * counter ends at exactly K; separate (org, year) sequences never interfere.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (typeof globalThis.WebSocket === 'undefined') {
  neonConfig.webSocketConstructor = ws;
}

describe.skipIf(!TEST_DATABASE_URL)(
  'invoice numbering under real Postgres concurrency',
  () => {
    const ORG = `org_inv_conc_${Date.now()}`;
    const OTHER = `org_inv_other_${Date.now()}`;
    let pool: Pool;
    let db: TenantDb;

    beforeAll(() => {
      pool = new Pool({ connectionString: TEST_DATABASE_URL });
      db = drizzle(pool, { schema }) as unknown as TenantDb;
    });

    afterAll(async () => {
      await pool.end();
    });

    it('K concurrent allocations yield K distinct, contiguous numbers; counter ends at K', async () => {
      const YEAR = 2026;
      const K = 25;
      const results = await Promise.all(
        Array.from({ length: K }, () =>
          runInOrg(db, ORG, (tx) => allocateInvoiceNumber(tx, ORG, YEAR)),
        ),
      );

      // No duplicates, exactly the set 1..K (order is nondeterministic) — gap-free.
      expect(new Set(results).size).toBe(K);
      expect([...results].sort((a, b) => a - b)).toEqual(
        Array.from({ length: K }, (_, i) => i + 1),
      );

      const [row] = await runInOrg(db, ORG, (tx) =>
        tx
          .select({ lastSeq: invoiceCounters.lastSeq })
          .from(invoiceCounters)
          .where(
            and(
              eq(invoiceCounters.organizationId, ORG),
              eq(invoiceCounters.year, YEAR),
            ),
          ),
      );
      expect(row!.lastSeq).toBe(K);
    });

    it('separate (org, year) sequences do not interfere under concurrency', async () => {
      const K = 15;
      // Same org, two years, plus a second org sharing one of the years — all fired
      // together. Each (org, year) must produce its own contiguous 1..K.
      const tasks = [
        ...Array.from({ length: K }, () => ['a', ORG, 2027] as const),
        ...Array.from({ length: K }, () => ['b', ORG, 2028] as const),
        ...Array.from({ length: K }, () => ['c', OTHER, 2027] as const),
      ];
      const settled = await Promise.all(
        tasks.map(async ([tag, org, year]) => ({
          tag,
          seq: await runInOrg(db, org, (tx) => allocateInvoiceNumber(tx, org, year)),
        })),
      );

      for (const tag of ['a', 'b', 'c'] as const) {
        const seqs = settled.filter((s) => s.tag === tag).map((s) => s.seq);
        expect(new Set(seqs).size).toBe(K);
        expect([...seqs].sort((a, b) => a - b)).toEqual(
          Array.from({ length: K }, (_, i) => i + 1),
        );
      }
    });
  },
);
