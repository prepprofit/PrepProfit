import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '@/lib/db/schema';
import { runInOrg, type TenantDb } from '@/lib/db/tenant';
import { createIngredient } from '@/lib/data/ingredients';
import { recordMovement } from '@/lib/data/inventory';
import { createArea, ensureDefaultArea } from '@/lib/data/storage-areas';
import { areaBalanceOf, transferStock } from '@/lib/data/inventory-areas';

/**
 * REAL-Postgres concurrency proof for the per-area transfer floor (Sprint 12c),
 * mirroring tests/concurrency/recipe-line.pg.test.ts. PGlite is a single in-process
 * connection and cannot run two transactions concurrently, so it cannot exercise the
 * `SELECT … FOR UPDATE` contention that protects the per-area balance — we need a real
 * Postgres with real concurrent sessions.
 *
 * Setup: point `TEST_DATABASE_URL` at a DISPOSABLE Neon branch that already has the
 * migrations + RLS applied (`DATABASE_URL=<branch> npm run db:migrate`). Without the
 * env var the whole describe is skipped (CI stays green with no database).
 *
 * The invariant: two concurrent transfers OUT of the same area on the same ingredient,
 * whose combined out-qty exceeds the source-area balance, must be serialized by the
 * per-ingredient lock so EXACTLY one succeeds and the other gets `insufficient_stock` —
 * the per-area balance never goes negative.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (typeof globalThis.WebSocket === 'undefined') {
  neonConfig.webSocketConstructor = ws;
}

describe.skipIf(!TEST_DATABASE_URL)(
  'per-area transfer floor under real Postgres concurrency',
  () => {
    const ORG = `org_12c_conc_${Date.now()}`;
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
      'serializes two oversold transfers out of the same area — exactly one wins (run %i)',
      async (n) => {
        // Fresh ingredient + a "Bar" area holding 100 (the default holds nothing).
        const { ingredientId, barId, defId } = await runInOrg(db, ORG, async (tx) => {
          const ing = await createIngredient(tx, ORG, {
            name: `I${n}-${Date.now()}`,
            dimension: 'weight',
            priceCents: 100,
          });
          const def = await ensureDefaultArea(tx, ORG);
          const bar = await createArea(tx, ORG, `Bar-${n}-${Date.now()}`);
          if (bar.status !== 'ok') throw new Error('seed area failed');
          await recordMovement(tx, ORG, {
            ingredientId: ing.id,
            deltaCanonical: 100,
            source: { type: 'manual' },
            idempotencyKey: `open-${n}-${Date.now()}`,
            storageAreaId: bar.area.id,
          });
          return { ingredientId: ing.id, barId: bar.area.id, defId: def.id };
        });

        // Two concurrent transfers of 60 each out of Bar (combined 120 > 100).
        const transfer = () =>
          runInOrg(db, ORG, (tx) =>
            transferStock(tx, ORG, {
              ingredientId,
              areaFromId: barId,
              areaToId: defId,
              qty: 60,
              clientTransferId: crypto.randomUUID(),
            }),
          ).catch((err) => ({ status: 'threw' as const, err }));

        const [a, b] = await Promise.all([transfer(), transfer()]);
        const statuses = [a.status, b.status].sort();
        // Exactly one ok, one insufficient_stock — never two successes.
        expect(statuses).toEqual(['insufficient_stock', 'ok']);

        // The Bar balance dropped by exactly one 60 transfer (100 → 40), never negative.
        const barBalance = await runInOrg(db, ORG, (tx) =>
          areaBalanceOf(tx, ORG, { id: barId, isDefault: false }, ingredientId),
        );
        expect(barBalance).toBe(40);
      },
    );
  },
);
