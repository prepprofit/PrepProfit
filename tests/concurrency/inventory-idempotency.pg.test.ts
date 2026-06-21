import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '@/lib/db/schema';
import { inventoryMovements } from '@/lib/db/schema';
import { runInOrg, type TenantDb } from '@/lib/db/tenant';
import { createIngredient } from '@/lib/data/ingredients';
import { recordMovement } from '@/lib/data/inventory';

/**
 * REAL-Postgres concurrency proof for the F1 ledger idempotency invariant.
 *
 * Why opt-in (mirrors recipe-line.pg.test.ts): PGlite is a SINGLE in-process
 * connection, so it cannot run two transactions concurrently and therefore cannot
 * exercise the per-ORG idempotency key vs per-INGREDIENT lock race — the exact
 * hole the post-`ON CONFLICT` full-payload revalidation (step 5) closes.
 *
 * Setup: point `TEST_DATABASE_URL` at a DISPOSABLE Neon branch with migrations +
 * RLS already applied (`DATABASE_URL=<branch> npm run db:migrate`). Without the
 * env var the whole describe is skipped (CI stays green with no database).
 *
 * The invariant under test: the SAME idempotency key reused for a DIFFERENT
 * payload (two different ingredients) raced across two transactions → exactly ONE
 * movement is inserted and the loser gets `idempotency_conflict` — never a silent
 * dedup that would skip a real, different stock change.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (typeof globalThis.WebSocket === 'undefined') {
  neonConfig.webSocketConstructor = ws;
}

describe.skipIf(!TEST_DATABASE_URL)(
  'inventory idempotency under real Postgres concurrency',
  () => {
    const ORG = `org_idem_conc_${Date.now()}`;
    let pool: Pool;
    let db: TenantDb;

    beforeAll(() => {
      pool = new Pool({ connectionString: TEST_DATABASE_URL });
      db = drizzle(pool, { schema }) as unknown as TenantDb;
    });

    afterAll(async () => {
      await pool.end();
    });

    it.each([0, 1, 2, 3, 4])(
      'same key / different payload races to exactly one insert + one conflict (run %i)',
      async (n) => {
        // Two fresh ingredients (positive stock-in, so the stock check passes).
        const { idA, idB } = await runInOrg(db, ORG, async (tx) => {
          const a = await createIngredient(tx, ORG, {
            name: `A${n}-${Date.now()}`,
            dimension: 'weight',
            priceCents: 100,
          });
          const b = await createIngredient(tx, ORG, {
            name: `B${n}-${Date.now()}`,
            dimension: 'weight',
            priceCents: 100,
          });
          return { idA: a.id, idB: b.id };
        });

        // ONE key, reused for two DIFFERENT ingredients, raced for real.
        const key = `manual:race-${n}-${Date.now()}`;
        const [resA, resB] = await Promise.all([
          runInOrg(db, ORG, (tx) =>
            recordMovement(tx, ORG, {
              ingredientId: idA,
              deltaCanonical: 100,
              source: { type: 'manual' },
              idempotencyKey: key,
            }),
          ),
          runInOrg(db, ORG, (tx) =>
            recordMovement(tx, ORG, {
              ingredientId: idB,
              deltaCanonical: 100,
              source: { type: 'manual' },
              idempotencyKey: key,
            }),
          ),
        ]);

        // Exactly one inserted (ok, NOT deduped); the other is a real conflict.
        const oks = [resA, resB].filter((r) => r.ok);
        const conflicts = [resA, resB].filter(
          (r) => !r.ok && r.reason === 'idempotency_conflict',
        );
        expect(oks).toHaveLength(1);
        expect(conflicts).toHaveLength(1);
        expect(oks[0]!.ok && oks[0]!.deduped).toBeFalsy();

        // And the ledger holds exactly one movement for that key.
        const rows = await runInOrg(db, ORG, (tx) =>
          tx
            .select({ id: inventoryMovements.id })
            .from(inventoryMovements)
            .where(
              and(
                eq(inventoryMovements.organizationId, ORG),
                eq(inventoryMovements.idempotencyKey, key),
              ),
            ),
        );
        expect(rows).toHaveLength(1);
      },
    );
  },
);
