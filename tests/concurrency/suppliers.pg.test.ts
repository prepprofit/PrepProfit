import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '@/lib/db/schema';
import { ingredientSuppliers, suppliers } from '@/lib/db/schema';
import { runInOrg, type TenantDb } from '@/lib/db/tenant';
import { createIngredient } from '@/lib/data/ingredients';
import { findOrCreateSupplierByName } from '@/lib/data/suppliers';
import { setDefaultSupplier } from '@/lib/data/ingredient-suppliers';

/**
 * REAL-Postgres concurrency proof for Sprint 7 (mirrors po-counter.pg.test.ts).
 * PGlite is single-connection, so it cannot exercise these races; this is opt-in
 * via TEST_DATABASE_URL (a disposable Neon branch with migrations + RLS applied)
 * and is skipped in CI.
 *
 * Invariants:
 *  - K concurrent find-or-create of the SAME name → exactly ONE supplier row
 *    (ON CONFLICT DO NOTHING + refetch);
 *  - two concurrent setDefaultSupplier on one ingredient → exactly ONE default
 *    link (the partial unique + clear-then-set ordering).
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (typeof globalThis.WebSocket === 'undefined') {
  neonConfig.webSocketConstructor = ws;
}

describe.skipIf(!TEST_DATABASE_URL)('suppliers under real Postgres concurrency', () => {
  const ORG = `org_sup_conc_${Date.now()}`;
  let pool: Pool;
  let db: TenantDb;

  beforeAll(() => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    db = drizzle(pool, { schema }) as unknown as TenantDb;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('K concurrent find-or-create of one name yield exactly one supplier row', async () => {
    const K = 16;
    await Promise.all(
      Array.from({ length: K }, () =>
        runInOrg(db, ORG, (tx) =>
          findOrCreateSupplierByName(tx, ORG, 'Concurrent Foods'),
        ),
      ),
    );
    const rows = await runInOrg(db, ORG, (tx) =>
      tx.select().from(suppliers).where(eq(suppliers.organizationId, ORG)),
    );
    expect(rows.filter((r) => r.name === 'Concurrent Foods')).toHaveLength(1);
  });

  it('two concurrent setDefaultSupplier leave exactly one default link', async () => {
    const ing = await runInOrg(db, ORG, (tx) =>
      createIngredient(tx, ORG, { name: `Conc-${Date.now()}`, dimension: 'weight', priceCents: 0 }),
    );
    await Promise.allSettled([
      runInOrg(db, ORG, (tx) =>
        setDefaultSupplier(tx, ORG, ing.id, { supplierName: 'Supplier One' }),
      ),
      runInOrg(db, ORG, (tx) =>
        setDefaultSupplier(tx, ORG, ing.id, { supplierName: 'Supplier Two' }),
      ),
    ]);

    const defaults = await runInOrg(db, ORG, (tx) =>
      tx
        .select()
        .from(ingredientSuppliers)
        .where(
          and(
            eq(ingredientSuppliers.organizationId, ORG),
            eq(ingredientSuppliers.ingredientId, ing.id),
            eq(ingredientSuppliers.isDefault, true),
          ),
        ),
    );
    expect(defaults).toHaveLength(1);
  });
});
