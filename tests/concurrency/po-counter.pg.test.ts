import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '@/lib/db/schema';
import { poCounters } from '@/lib/db/schema';
import { runInOrg, type TenantDb } from '@/lib/db/tenant';
import { allocatePoNumber } from '@/lib/data/po-counters';

/**
 * REAL-Postgres concurrency proof for the F6 PO counter.
 *
 * Why opt-in (mirrors inventory-idempotency.pg.test.ts): PGlite is a SINGLE
 * in-process connection, so it cannot run two transactions concurrently and
 * therefore cannot exercise the row-lock that serializes concurrent allocations —
 * the exact property `allocatePoNumber`'s atomic upsert-increment guarantees.
 *
 * Setup: point `TEST_DATABASE_URL` at a DISPOSABLE Neon branch with migrations +
 * RLS already applied (`DATABASE_URL=<branch> npm run db:migrate`). Without the env
 * var the whole describe is skipped (CI stays green with no database).
 *
 * The invariant under test: K concurrent allocations for one org return K DISTINCT
 * numbers (no collision, no lost update) and the counter ends at exactly K.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (typeof globalThis.WebSocket === 'undefined') {
  neonConfig.webSocketConstructor = ws;
}

describe.skipIf(!TEST_DATABASE_URL)(
  'PO counter under real Postgres concurrency',
  () => {
    const ORG = `org_po_conc_${Date.now()}`;
    let pool: Pool;
    let db: TenantDb;

    beforeAll(() => {
      pool = new Pool({ connectionString: TEST_DATABASE_URL });
      db = drizzle(pool, { schema }) as unknown as TenantDb;
    });

    afterAll(async () => {
      await pool.end();
    });

    it('K concurrent allocations yield K distinct numbers, counter ends at K', async () => {
      const K = 20;
      const results = await Promise.all(
        Array.from({ length: K }, () =>
          runInOrg(db, ORG, (tx) => allocatePoNumber(tx, ORG)),
        ),
      );

      // No duplicates, exactly the set 1..K (order is nondeterministic).
      expect(new Set(results).size).toBe(K);
      expect([...results].sort((a, b) => a - b)).toEqual(
        Array.from({ length: K }, (_, i) => i + 1),
      );

      const [row] = await runInOrg(db, ORG, (tx) =>
        tx
          .select({ lastSeq: poCounters.lastSeq })
          .from(poCounters)
          .where(and(eq(poCounters.organizationId, ORG))),
      );
      expect(row!.lastSeq).toBe(K);
    });
  },
);
