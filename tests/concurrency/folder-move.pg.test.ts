import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '@/lib/db/schema';
import { runInOrg, type TenantDb } from '@/lib/db/tenant';
import { createFolder, listFolders, moveFolder } from '@/lib/data/recipe-folders';

/**
 * REAL-Postgres concurrency proof for the nested-folder cycle invariant.
 *
 * PGlite is a single in-process connection, so it cannot race two transactions;
 * `moveFolder`'s correctness under concurrency comes from locking EVERY folder
 * row of the org FOR UPDATE (id order, deadlock-free) before validating the
 * move — the second writer blocks on the first's lock, then re-reads the tree
 * AFTER the first commits and sees the new edge. Point `TEST_DATABASE_URL` at a
 * disposable Neon branch with migrations + RLS applied; without it, this suite
 * is skipped, same as tests/concurrency/recipe-components.pg.test.ts.
 *
 * The invariant under test: concurrently reparenting A under B and B under A
 * can NEVER both commit (no persisted 2-cycle).
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (typeof globalThis.WebSocket === 'undefined') {
  neonConfig.webSocketConstructor = ws;
}

describe.skipIf(!TEST_DATABASE_URL)(
  'recipe_folders nesting invariant under real Postgres concurrency',
  () => {
    const ORG = `org_folder_move_conc_${Date.now()}`;
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
      'concurrent A→under-B and B→under-A moves cannot both commit (run %i)',
      async (n) => {
        const { aId, bId } = await runInOrg(db, ORG, async (tx) => {
          const a = await createFolder(tx, ORG, `A${n}-${Date.now()}`);
          const b = await createFolder(tx, ORG, `B${n}-${Date.now()}`);
          return { aId: a.id, bId: b.id };
        });

        const [aUnderB, bUnderA] = await Promise.allSettled([
          runInOrg(db, ORG, (tx) => moveFolder(tx, ORG, aId, bId)),
          runInOrg(db, ORG, (tx) => moveFolder(tx, ORG, bId, aId)),
        ]);

        // A lost race is a clean `DESCENDANT` refusal, never a throw/deadlock.
        expect(aUnderB.status).toBe('fulfilled');
        expect(bUnderA.status).toBe('fulfilled');

        const okCount = [aUnderB, bUnderA].filter(
          (r) => r.status === 'fulfilled' && r.value.ok,
        ).length;
        // THE INVARIANT: exactly one writer succeeded (progress, no double-loss)…
        expect(okCount).toBe(1);

        // …and the resulting tree has no cycle: walking parent_id from either
        // folder terminates at a root within two hops.
        const folders = await runInOrg(db, ORG, (tx) => listFolders(tx, ORG));
        const byId = new Map(folders.map((f) => [f.id, f]));
        for (const startId of [aId, bId]) {
          let current = byId.get(startId);
          let hops = 0;
          const seen = new Set<string>();
          while (current?.parentId != null) {
            expect(seen.has(current.id)).toBe(false);
            seen.add(current.id);
            current = byId.get(current.parentId);
            hops += 1;
            expect(hops).toBeLessThanOrEqual(2);
          }
        }
      },
    );
  },
);
