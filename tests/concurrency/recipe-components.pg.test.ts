import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '@/lib/db/schema';
import { recipeComponents } from '@/lib/db/schema';
import { runInOrg, type TenantDb } from '@/lib/db/tenant';
import { createRecipe } from '@/lib/data/recipes';
import { addRecipeComponent } from '@/lib/data/recipe-components';

/**
 * REAL-Postgres concurrency proof for the sub-recipe DAG invariant.
 *
 * PGlite is a single in-process connection, so it cannot race two transactions;
 * the cycle check's correctness under concurrency comes from BOTH writers
 * locking the SAME two recipe rows FOR UPDATE in deterministic id order before
 * running the reachability CTE — the second writer blocks, then sees the first
 * edge and is rejected. Point `TEST_DATABASE_URL` at a disposable Neon branch
 * with migrations + RLS applied; without it, this suite is skipped.
 *
 * The invariant under test: concurrent A→B and B→A inserts can NEVER both
 * commit (no persisted 2-cycle).
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (typeof globalThis.WebSocket === 'undefined') {
  neonConfig.webSocketConstructor = ws;
}

describe.skipIf(!TEST_DATABASE_URL)(
  'recipe_components DAG invariant under real Postgres concurrency',
  () => {
    const ORG = `org_rc_conc_${Date.now()}`;
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
      'concurrent A→B and B→A inserts cannot both commit (run %i)',
      async (n) => {
        const { aId, bId } = await runInOrg(db, ORG, async (tx) => {
          const a = await createRecipe(tx, ORG, {
            name: `A${n}-${Date.now()}`,
            yieldWeightGrams: 1000,
          });
          const b = await createRecipe(tx, ORG, {
            name: `B${n}-${Date.now()}`,
            yieldWeightGrams: 1000,
          });
          return { aId: a.id, bId: b.id };
        });

        const [ab, ba] = await Promise.allSettled([
          runInOrg(db, ORG, (tx) =>
            addRecipeComponent(tx, ORG, aId, {
              componentRecipeId: bId,
              quantityGrams: 100,
            }),
          ),
          runInOrg(db, ORG, (tx) =>
            addRecipeComponent(tx, ORG, bId, {
              componentRecipeId: aId,
              quantityGrams: 100,
            }),
          ),
        ]);

        // A lost race is a clean `cycle` refusal, never a throw/deadlock.
        expect(ab.status).toBe('fulfilled');
        expect(ba.status).toBe('fulfilled');

        const edges = await runInOrg(db, ORG, (tx) =>
          tx
            .select({
              recipeId: recipeComponents.recipeId,
              componentRecipeId: recipeComponents.componentRecipeId,
            })
            .from(recipeComponents)
            .where(
              or(
                eq(recipeComponents.recipeId, aId),
                eq(recipeComponents.recipeId, bId),
              ),
            ),
        );

        // THE INVARIANT: at most one of the two edges persisted…
        expect(edges.length).toBeLessThanOrEqual(1);
        // …and exactly one writer succeeded (progress, no double-loss).
        const okCount = [ab, ba].filter(
          (r) => r.status === 'fulfilled' && r.value.ok,
        ).length;
        expect(okCount).toBe(1);
        expect(edges.length).toBe(1);
      },
    );
  },
);
