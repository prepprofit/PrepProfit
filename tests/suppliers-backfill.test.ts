import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { ingredientSuppliers, suppliers } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { createIngredient, getIngredientById } from '@/lib/data/ingredients';
import { createSupplier } from '@/lib/data/suppliers';
import { setDefaultSupplier } from '@/lib/data/ingredient-suppliers';
import { backfillSuppliersForOrg } from '@/lib/data/supplier-backfill';

/**
 * Sprint 7 backfill (§12.1/§12.2/§12.13): legacy `ingredients.supplier` text → real
 * suppliers + default links, idempotently and RLS-scoped (run as `tenant_app`).
 */
const ORG = 'org_backfill';

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

const makeIngredient = (name: string, supplier: string | null) =>
  runInOrg(db, ORG, (tx) =>
    createIngredient(tx, ORG, {
      name,
      dimension: 'weight',
      priceCents: 0,
      supplier,
    }),
  );

describe('backfillSuppliersForOrg', () => {
  it('collapses spelling variants to one supplier, links + syncs the legacy mirror', async () => {
    const a = await makeIngredient('Flour-bf', 'ACME');
    const b = await makeIngredient('Sugar-bf', 'acme'); // same key as 'ACME'
    const c = await makeIngredient('Salt-bf', 'Beta Co');
    const blank = await makeIngredient('Pepper-bf', '   '); // blank → no supplier

    const stats = await runInOrg(db, ORG, (tx) => backfillSuppliersForOrg(tx, ORG));
    expect(stats.suppliersCreated).toBe(2); // ACME (key) + Beta Co
    expect(stats.linksCreated).toBe(3); // a, b, c (not the blank one)

    // One supplier per normalized key.
    const supplierRows = await runInOrg(db, ORG, (tx) =>
      tx.select().from(suppliers).where(eq(suppliers.organizationId, ORG)),
    );
    const names = supplierRows.map((s) => s.name).sort();
    expect(names).toEqual(['ACME', 'Beta Co']); // 'ACME' < 'Acme' lexicographically

    // Legacy mirror synced to the canonical chosen name (§12.1).
    expect((await runInOrg(db, ORG, (tx) => getIngredientById(tx, ORG, a.id)))?.supplier).toBe(
      'ACME',
    );
    expect((await runInOrg(db, ORG, (tx) => getIngredientById(tx, ORG, b.id)))?.supplier).toBe(
      'ACME',
    );
    // The blank-supplier ingredient is untouched (still no link).
    const blankLinks = await runInOrg(db, ORG, (tx) =>
      tx
        .select()
        .from(ingredientSuppliers)
        .where(
          and(
            eq(ingredientSuppliers.organizationId, ORG),
            eq(ingredientSuppliers.ingredientId, blank.id),
          ),
        ),
    );
    expect(blankLinks).toHaveLength(0);

    void c;
  });

  it('preserves an existing default link, only syncing the legacy mirror (§12.2)', async () => {
    // An ingredient that already has a default to a DIFFERENT supplier than its
    // legacy text would imply.
    const ing = await makeIngredient('Yeast-bf', 'Stale Text Co');
    await runInOrg(db, ORG, (tx) =>
      createSupplier(tx, ORG, {
        name: 'Real Supplier',
        email: null,
        phone: null,
        address: null,
        taxId: null,
        notes: null,
      }),
    );
    await runInOrg(db, ORG, (tx) =>
      setDefaultSupplier(tx, ORG, ing.id, { supplierName: 'Real Supplier' }),
    );

    await runInOrg(db, ORG, (tx) => backfillSuppliersForOrg(tx, ORG));

    // The existing default wins; legacy mirror points at it (not 'Stale Text Co').
    const links = await runInOrg(db, ORG, (tx) =>
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
    expect(links).toHaveLength(1);
    const refreshed = await runInOrg(db, ORG, (tx) =>
      getIngredientById(tx, ORG, ing.id),
    );
    expect(refreshed?.supplier).toBe('Real Supplier');
  });

  it('is idempotent — a second run creates no duplicates', async () => {
    const before = await runInOrg(db, ORG, (tx) =>
      tx.select().from(suppliers).where(eq(suppliers.organizationId, ORG)),
    );
    const linksBefore = await runInOrg(db, ORG, (tx) =>
      tx
        .select()
        .from(ingredientSuppliers)
        .where(eq(ingredientSuppliers.organizationId, ORG)),
    );

    const stats = await runInOrg(db, ORG, (tx) => backfillSuppliersForOrg(tx, ORG));
    expect(stats.suppliersCreated).toBe(0);
    expect(stats.linksCreated).toBe(0);

    const after = await runInOrg(db, ORG, (tx) =>
      tx.select().from(suppliers).where(eq(suppliers.organizationId, ORG)),
    );
    const linksAfter = await runInOrg(db, ORG, (tx) =>
      tx
        .select()
        .from(ingredientSuppliers)
        .where(eq(ingredientSuppliers.organizationId, ORG)),
    );
    expect(after.length).toBe(before.length);
    expect(linksAfter.length).toBe(linksBefore.length);
  });
});
