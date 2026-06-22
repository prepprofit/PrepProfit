import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import {
  ingredients,
  ingredientSuppliers,
  ingredientPriceHistory,
  suppliers,
} from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { createIngredient, getIngredientById } from '@/lib/data/ingredients';
import { acceptPendingCost } from '@/lib/data/ingredient-pricing';
import {
  archiveSupplier,
  createSupplier,
  findOrCreateSupplierByName,
  getSupplierById,
  reactivateSupplier,
  updateSupplier,
} from '@/lib/data/suppliers';
import {
  clearDefaultSupplier,
  getDefaultLink,
  hasIncompatiblePacks,
  setDefaultSupplier,
} from '@/lib/data/ingredient-suppliers';

/**
 * Suppliers (Sprint 7) under the non-privileged `tenant_app` role so RLS is
 * enforced. Proves: empty-key rejection, normalized-name dedup, atomic
 * find-or-create, one default per ingredient, the dual-write (supplier + link +
 * legacy mirror), rename propagation, pending-cost on real pack changes (no-op when
 * unchanged), accept, archive/inactive guards, unit↔dimension validation, the DB
 * CHECKs, cross-org isolation, and FK-restrict on a linked supplier.
 */
const ORG_A = 'org_a';
const ORG_B = 'org_b';

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

const supplierInput = (name: string) => ({
  name,
  email: null,
  phone: null,
  address: null,
  taxId: null,
  notes: null,
});

async function newIngredient(
  org: string,
  name: string,
  dimension: 'weight' | 'volume' | 'count' = 'weight',
  priceCents = 0,
): Promise<string> {
  const ing = await runInOrg(db, org, (tx) =>
    createIngredient(tx, org, { name, dimension, priceCents }),
  );
  return ing.id;
}

describe('createSupplier + dedup', () => {
  it('rejects an empty / whitespace-only name', async () => {
    const result = await runInOrg(db, ORG_A, (tx) =>
      createSupplier(tx, ORG_A, supplierInput('   ')),
    );
    expect(result.status).toBe('invalid_name');
  });

  it('dedups on the normalized name within an org', async () => {
    const first = await runInOrg(db, ORG_A, (tx) =>
      createSupplier(tx, ORG_A, supplierInput('ACME Foods')),
    );
    expect(first.status).toBe('ok');
    const second = await runInOrg(db, ORG_A, (tx) =>
      createSupplier(tx, ORG_A, supplierInput('  acme   foods ')),
    );
    expect(second.status).toBe('duplicate');
  });
});

describe('findOrCreateSupplierByName', () => {
  it('rejects the empty key', async () => {
    const r = await runInOrg(db, ORG_A, (tx) =>
      findOrCreateSupplierByName(tx, ORG_A, '  '),
    );
    expect(r.status).toBe('invalid_name');
  });

  it('is atomic — two calls converge on one row', async () => {
    const a = await runInOrg(db, ORG_A, (tx) =>
      findOrCreateSupplierByName(tx, ORG_A, 'Bingo Wholesale'),
    );
    const b = await runInOrg(db, ORG_A, (tx) =>
      findOrCreateSupplierByName(tx, ORG_A, 'bingo wholesale'),
    );
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    if (a.status === 'ok' && b.status === 'ok') {
      expect(b.supplier.id).toBe(a.supplier.id);
    }
  });

  it('returns `inactive` for an archived supplier (never silently revived)', async () => {
    const created = await runInOrg(db, ORG_A, (tx) =>
      createSupplier(tx, ORG_A, supplierInput('Sleepy Supplier')),
    );
    if (created.status !== 'ok') throw new Error('setup');
    await runInOrg(db, ORG_A, (tx) =>
      archiveSupplier(tx, ORG_A, created.supplier.id),
    );
    const found = await runInOrg(db, ORG_A, (tx) =>
      findOrCreateSupplierByName(tx, ORG_A, 'sleepy supplier'),
    );
    expect(found.status).toBe('inactive');
  });
});

describe('setDefaultSupplier — dual-write', () => {
  it('creates supplier + default link + mirrors the legacy column', async () => {
    const ingId = await newIngredient(ORG_A, 'Cocoa', 'weight');
    const result = await runInOrg(db, ORG_A, (tx) =>
      setDefaultSupplier(tx, ORG_A, ingId, { supplierName: 'Choco Co' }),
    );
    expect(result.status).toBe('ok');

    const link = await runInOrg(db, ORG_A, (tx) => getDefaultLink(tx, ORG_A, ingId));
    expect(link?.supplier.name).toBe('Choco Co');

    const ing = await runInOrg(db, ORG_A, (tx) =>
      getIngredientById(tx, ORG_A, ingId),
    );
    expect(ing?.supplier).toBe('Choco Co');
  });

  it('keeps exactly one default per ingredient when the supplier changes', async () => {
    const ingId = await newIngredient(ORG_A, 'Vanilla', 'weight');
    await runInOrg(db, ORG_A, (tx) =>
      setDefaultSupplier(tx, ORG_A, ingId, { supplierName: 'First Supplier' }),
    );
    await runInOrg(db, ORG_A, (tx) =>
      setDefaultSupplier(tx, ORG_A, ingId, { supplierName: 'Second Supplier' }),
    );

    const defaults = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select()
        .from(ingredientSuppliers)
        .where(
          and(
            eq(ingredientSuppliers.organizationId, ORG_A),
            eq(ingredientSuppliers.ingredientId, ingId),
            eq(ingredientSuppliers.isDefault, true),
          ),
        ),
    );
    expect(defaults).toHaveLength(1);
    const link = await runInOrg(db, ORG_A, (tx) => getDefaultLink(tx, ORG_A, ingId));
    expect(link?.supplier.name).toBe('Second Supplier');
  });

  it('refuses to attach an archived supplier (SUPPLIER_INACTIVE)', async () => {
    const ingId = await newIngredient(ORG_A, 'Nutmeg', 'weight');
    const created = await runInOrg(db, ORG_A, (tx) =>
      createSupplier(tx, ORG_A, supplierInput('Archived Spice Co')),
    );
    if (created.status !== 'ok') throw new Error('setup');
    await runInOrg(db, ORG_A, (tx) => archiveSupplier(tx, ORG_A, created.supplier.id));

    const result = await runInOrg(db, ORG_A, (tx) =>
      setDefaultSupplier(tx, ORG_A, ingId, { supplierName: 'archived spice co' }),
    );
    expect(result.status).toBe('supplier_inactive');
  });

  it('rejects a pack unit whose dimension mismatches the ingredient', async () => {
    const ingId = await newIngredient(ORG_A, 'Olive oil', 'volume');
    const result = await runInOrg(db, ORG_A, (tx) =>
      setDefaultSupplier(tx, ORG_A, ingId, {
        supplierName: 'Oil Co',
        packSize: 5,
        packUnit: 'kg', // weight on a volume ingredient
        packPriceCents: 1000,
      }),
    );
    expect(result.status).toBe('pack_unit_mismatch');
  });
});

describe('pending cost from a pack price', () => {
  it('raises pending on a real pack change, then accept moves it to price', async () => {
    const ingId = await newIngredient(ORG_A, 'Almond flour', 'weight', 100);
    const first = await runInOrg(db, ORG_A, (tx) =>
      setDefaultSupplier(tx, ORG_A, ingId, {
        supplierName: 'Nutty Co',
        packSize: 5,
        packUnit: 'kg',
        packPriceCents: 2000, // €20 / 5 kg → 400 c/kg
      }),
    );
    expect(first.status === 'ok' && first.pendingRaised).toBe(true);

    let ing = await runInOrg(db, ORG_A, (tx) => getIngredientById(tx, ORG_A, ingId));
    expect(ing?.priceCents).toBe(100);
    expect(ing?.pendingPriceCents).toBe(400);

    // The history row carries the originating link id (provenance, §12.5).
    const link = await runInOrg(db, ORG_A, (tx) => getDefaultLink(tx, ORG_A, ingId));
    const hist = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select()
        .from(ingredientPriceHistory)
        .where(
          and(
            eq(ingredientPriceHistory.organizationId, ORG_A),
            eq(ingredientPriceHistory.ingredientId, ingId),
          ),
        ),
    );
    expect(hist).toHaveLength(1);
    expect(hist[0]?.ingredientSupplierId).toBe(link?.link.id);

    await runInOrg(db, ORG_A, (tx) => acceptPendingCost(tx, ORG_A, ingId));
    ing = await runInOrg(db, ORG_A, (tx) => getIngredientById(tx, ORG_A, ingId));
    expect(ing?.priceCents).toBe(400);
    expect(ing?.pendingPriceCents).toBeNull();
  });

  it('is a no-op when the pack is unchanged (no new history, no re-opened pending)', async () => {
    const ingId = await newIngredient(ORG_A, 'Hazelnut', 'weight');
    await runInOrg(db, ORG_A, (tx) =>
      setDefaultSupplier(tx, ORG_A, ingId, {
        supplierName: 'Hazel Co',
        packSize: 2,
        packUnit: 'kg',
        packPriceCents: 1000,
      }),
    );
    await runInOrg(db, ORG_A, (tx) => acceptPendingCost(tx, ORG_A, ingId));

    // Save the SAME supplier + SAME pack again.
    const again = await runInOrg(db, ORG_A, (tx) =>
      setDefaultSupplier(tx, ORG_A, ingId, {
        supplierName: 'Hazel Co',
        packSize: 2,
        packUnit: 'kg',
        packPriceCents: 1000,
      }),
    );
    expect(again.status === 'ok' && again.pendingRaised).toBe(false);

    const ing = await runInOrg(db, ORG_A, (tx) => getIngredientById(tx, ORG_A, ingId));
    expect(ing?.pendingPriceCents).toBeNull(); // not re-opened
    const hist = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select()
        .from(ingredientPriceHistory)
        .where(
          and(
            eq(ingredientPriceHistory.organizationId, ORG_A),
            eq(ingredientPriceHistory.ingredientId, ingId),
          ),
        ),
    );
    expect(hist).toHaveLength(1); // no new row from the unchanged re-save
  });
});

describe('rename propagation + clear', () => {
  it('renaming a default supplier updates the legacy mirror on its ingredients', async () => {
    const ingId = await newIngredient(ORG_A, 'Cinnamon', 'weight');
    const set = await runInOrg(db, ORG_A, (tx) =>
      setDefaultSupplier(tx, ORG_A, ingId, { supplierName: 'Old Name Co' }),
    );
    if (set.status !== 'ok') throw new Error('setup');

    await runInOrg(db, ORG_A, (tx) =>
      updateSupplier(tx, ORG_A, set.supplier.id, supplierInput('New Name Co')),
    );

    const ing = await runInOrg(db, ORG_A, (tx) => getIngredientById(tx, ORG_A, ingId));
    expect(ing?.supplier).toBe('New Name Co');
  });

  it('clearDefaultSupplier removes the link and clears the legacy text', async () => {
    const ingId = await newIngredient(ORG_A, 'Cardamom', 'weight');
    await runInOrg(db, ORG_A, (tx) =>
      setDefaultSupplier(tx, ORG_A, ingId, { supplierName: 'Spice Source' }),
    );
    const cleared = await runInOrg(db, ORG_A, (tx) =>
      clearDefaultSupplier(tx, ORG_A, ingId),
    );
    expect(cleared).toBe(true);

    const link = await runInOrg(db, ORG_A, (tx) => getDefaultLink(tx, ORG_A, ingId));
    expect(link).toBeNull();
    const ing = await runInOrg(db, ORG_A, (tx) => getIngredientById(tx, ORG_A, ingId));
    expect(ing?.supplier).toBeNull();
  });
});

describe('archive guard + dimension guard', () => {
  it('archiving a default supplier is refused (in_use)', async () => {
    const ingId = await newIngredient(ORG_A, 'Saffron', 'weight');
    const set = await runInOrg(db, ORG_A, (tx) =>
      setDefaultSupplier(tx, ORG_A, ingId, { supplierName: 'Premium Spice' }),
    );
    if (set.status !== 'ok') throw new Error('setup');

    const result = await runInOrg(db, ORG_A, (tx) =>
      archiveSupplier(tx, ORG_A, set.supplier.id),
    );
    expect(result.status).toBe('in_use');

    // After clearing the link, it can be archived (and reactivated).
    await runInOrg(db, ORG_A, (tx) => clearDefaultSupplier(tx, ORG_A, ingId));
    const ok = await runInOrg(db, ORG_A, (tx) =>
      archiveSupplier(tx, ORG_A, set.supplier.id),
    );
    expect(ok.status).toBe('ok');
    const back = await runInOrg(db, ORG_A, (tx) =>
      reactivateSupplier(tx, ORG_A, set.supplier.id),
    );
    expect(back?.active).toBe(true);
  });

  it('hasIncompatiblePacks flags a dimension change that breaks a pack', async () => {
    const ingId = await newIngredient(ORG_A, 'Honey', 'weight');
    await runInOrg(db, ORG_A, (tx) =>
      setDefaultSupplier(tx, ORG_A, ingId, {
        supplierName: 'Bee Co',
        packSize: 1,
        packUnit: 'kg',
        packPriceCents: 500,
      }),
    );
    // A kg pack is incompatible with a 'volume' ingredient.
    const breaks = await runInOrg(db, ORG_A, (tx) =>
      hasIncompatiblePacks(tx, ORG_A, ingId, 'volume'),
    );
    expect(breaks).toBe(true);
    const fine = await runInOrg(db, ORG_A, (tx) =>
      hasIncompatiblePacks(tx, ORG_A, ingId, 'weight'),
    );
    expect(fine).toBe(false);
  });
});

describe('DB CHECK constraints', () => {
  it('rejects a non-positive pack size, negative price, and price without a pack', async () => {
    const ingId = await newIngredient(ORG_A, 'Check ingredient', 'weight');
    const sup = await runInOrg(db, ORG_A, (tx) =>
      createSupplier(tx, ORG_A, supplierInput('Check Supplier')),
    );
    if (sup.status !== 'ok') throw new Error('setup');
    const supplierId = sup.supplier.id;

    const insertBad = (values: Record<string, unknown>) =>
      runInOrg(db, ORG_A, (tx) =>
        tx.insert(ingredientSuppliers).values({
          organizationId: ORG_A,
          ingredientId: ingId,
          supplierId,
          ...values,
        } as never),
      );

    await expect(
      insertBad({ packSize: '0', packUnit: 'kg', packPriceCents: 100 }),
    ).rejects.toThrow();
    await expect(
      insertBad({ packSize: '5', packUnit: 'kg', packPriceCents: -1 }),
    ).rejects.toThrow();
    await expect(insertBad({ packPriceCents: 100 })).rejects.toThrow();
  });
});

describe('multi-tenant isolation + FK restrict', () => {
  it('a supplier is invisible to another org under RLS', async () => {
    const created = await runInOrg(db, ORG_A, (tx) =>
      createSupplier(tx, ORG_A, supplierInput('A-only Supplier')),
    );
    if (created.status !== 'ok') throw new Error('setup');

    const seenFromB = await runInOrg(db, ORG_B, (tx) =>
      tx
        .select()
        .from(suppliers)
        .where(eq(suppliers.organizationId, ORG_A)),
    );
    expect(seenFromB).toHaveLength(0);

    const fromB = await runInOrg(db, ORG_B, (tx) =>
      getSupplierById(tx, ORG_B, created.supplier.id),
    );
    expect(fromB).toBeNull();
  });

  it('deleting a supplier that has a link is blocked by the FK (restrict)', async () => {
    const ingId = await newIngredient(ORG_A, 'Linked ingredient', 'weight');
    const set = await runInOrg(db, ORG_A, (tx) =>
      setDefaultSupplier(tx, ORG_A, ingId, { supplierName: 'Linked Supplier' }),
    );
    if (set.status !== 'ok') throw new Error('setup');

    await expect(
      runInOrg(db, ORG_A, (tx) =>
        tx
          .delete(suppliers)
          .where(
            and(
              eq(suppliers.organizationId, ORG_A),
              eq(suppliers.id, set.supplier.id),
            ),
          ),
      ),
    ).rejects.toThrow();
  });

  it('purging an ingredient cascades its supplier links', async () => {
    const ingId = await newIngredient(ORG_A, 'Doomed ingredient', 'weight');
    await runInOrg(db, ORG_A, (tx) =>
      setDefaultSupplier(tx, ORG_A, ingId, { supplierName: 'Cascade Co' }),
    );
    await runInOrg(db, ORG_A, (tx) =>
      tx
        .delete(ingredients)
        .where(
          and(eq(ingredients.organizationId, ORG_A), eq(ingredients.id, ingId)),
        ),
    );
    const links = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select()
        .from(ingredientSuppliers)
        .where(
          and(
            eq(ingredientSuppliers.organizationId, ORG_A),
            eq(ingredientSuppliers.ingredientId, ingId),
          ),
        ),
    );
    expect(links).toHaveLength(0);
  });
});
