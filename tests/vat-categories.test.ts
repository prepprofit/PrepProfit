import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { ingredients, vatCategories } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { createIngredient, getIngredientById } from '@/lib/data/ingredients';
import { setDefaultSupplier } from '@/lib/data/ingredient-suppliers';
import {
  createVatCategory,
  deleteVatCategory,
  ensureVatCategories,
  listVatCategories,
  resolveVatRateBps,
  updateVatCategory,
} from '@/lib/data/vat-categories';

/**
 * Purchase VAT bands, under the non-privileged `tenant_app` role so RLS is
 * enforced. Proves: seeding is idempotent + non-destructive, the rate resolves
 * own-band → org default → null, delete guards (in use / is default), duplicate
 * names, cross-org isolation, and — the point of the whole feature — that an
 * incl.-VAT supplier quote is converted with the INGREDIENT'S band rate, not one
 * global number.
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

async function newIngredient(org: string, name: string): Promise<string> {
  const row = await runInOrg(db, org, (tx) =>
    createIngredient(tx, org, { name, dimension: 'weight', priceCents: 0 }),
  );
  return row.id;
}

/** The band the org uses by name, for tests that need its id. */
async function bandId(org: string, name: string): Promise<string> {
  const rows = await runInOrg(db, org, (tx) => listVatCategories(tx, org));
  const found = rows.find((r) => r.name === name);
  if (!found) throw new Error(`No band ${name} in ${org}`);
  return found.id;
}

describe('ensureVatCategories', () => {
  it('seeds the Finnish defaults once and never re-seeds', async () => {
    await runInOrg(db, ORG_A, (tx) => ensureVatCategories(tx, ORG_A));
    const first = await runInOrg(db, ORG_A, (tx) => listVatCategories(tx, ORG_A));
    expect(first.map((c) => [c.name, c.rateBps])).toEqual([
      ['Food', 1400],
      ['Alcohol', 2550],
      ['Non-food', 2550],
    ]);
    expect(first.filter((c) => c.isDefault)).toHaveLength(1);

    // A second call is a no-op even after the user edited and deleted bands.
    await runInOrg(db, ORG_A, (tx) =>
      updateVatCategory(tx, ORG_A, first[2]!.id, { name: 'Supplies', rateBps: 2000 }),
    );
    await runInOrg(db, ORG_A, (tx) => ensureVatCategories(tx, ORG_A));
    const second = await runInOrg(db, ORG_A, (tx) => listVatCategories(tx, ORG_A));
    expect(second).toHaveLength(3);
    expect(second.some((c) => c.name === 'Supplies' && c.rateBps === 2000)).toBe(true);
  });

  it('keeps each org on its own bands', async () => {
    await runInOrg(db, ORG_B, (tx) => ensureVatCategories(tx, ORG_B));
    const a = await runInOrg(db, ORG_A, (tx) => listVatCategories(tx, ORG_A));
    const b = await runInOrg(db, ORG_B, (tx) => listVatCategories(tx, ORG_B));
    expect(b).toHaveLength(3);
    // Same names, different rows — no id from A is visible in B.
    expect(a.map((c) => c.id).some((id) => b.map((r) => r.id).includes(id))).toBe(false);
  });
});

describe('resolveVatRateBps', () => {
  it('prefers the ingredient band, falls back to the org default', async () => {
    const alcohol = await bandId(ORG_A, 'Alcohol');
    const own = await runInOrg(db, ORG_A, (tx) =>
      resolveVatRateBps(tx, ORG_A, alcohol),
    );
    expect(own).toBe(2550);

    const fallback = await runInOrg(db, ORG_A, (tx) =>
      resolveVatRateBps(tx, ORG_A, null),
    );
    expect(fallback).toBe(1400); // the Food band, seeded as default
  });

  it('falls back rather than pricing at 0% for a band from another org', async () => {
    const foreign = await bandId(ORG_B, 'Alcohol');
    const rate = await runInOrg(db, ORG_A, (tx) =>
      resolveVatRateBps(tx, ORG_A, foreign),
    );
    expect(rate).toBe(1400);
  });

  it('is null when the org has no bands at all', async () => {
    const rate = await runInOrg(db, 'org_empty', (tx) =>
      resolveVatRateBps(tx, 'org_empty', null),
    );
    expect(rate).toBeNull();
  });
});

describe('create / update / delete', () => {
  it('refuses a duplicate name, case-insensitively', async () => {
    const dup = await runInOrg(db, ORG_A, (tx) =>
      createVatCategory(tx, ORG_A, { name: 'food', rateBps: 900 }),
    );
    expect(dup.status).toBe('duplicate_name');
  });

  it('refuses to delete the default band', async () => {
    const food = await bandId(ORG_A, 'Food');
    const result = await runInOrg(db, ORG_A, (tx) =>
      deleteVatCategory(tx, ORG_A, food),
    );
    expect(result.status).toBe('is_default');
  });

  it('refuses to delete a band an ingredient still uses', async () => {
    const alcohol = await bandId(ORG_A, 'Alcohol');
    const ingId = await newIngredient(ORG_A, 'Cooking wine');
    await runInOrg(db, ORG_A, (tx) =>
      tx
        .update(ingredients)
        .set({ vatCategoryId: alcohol })
        .where(and(eq(ingredients.organizationId, ORG_A), eq(ingredients.id, ingId))),
    );

    const blocked = await runInOrg(db, ORG_A, (tx) =>
      deleteVatCategory(tx, ORG_A, alcohol),
    );
    expect(blocked.status).toBe('in_use');

    // Freed up once nothing points at it.
    await runInOrg(db, ORG_A, (tx) =>
      tx
        .update(ingredients)
        .set({ vatCategoryId: null })
        .where(and(eq(ingredients.organizationId, ORG_A), eq(ingredients.id, ingId))),
    );
    const freed = await runInOrg(db, ORG_A, (tx) =>
      deleteVatCategory(tx, ORG_A, alcohol),
    );
    expect(freed.status).toBe('ok');
  });

  it('does not touch another org’s band', async () => {
    const foreign = await bandId(ORG_B, 'Non-food');
    const result = await runInOrg(db, ORG_A, (tx) =>
      updateVatCategory(tx, ORG_A, foreign, { name: 'Hijacked', rateBps: 0 }),
    );
    expect(result.status).toBe('not_found');
    const [row] = await runInOrg(db, ORG_B, (tx) =>
      tx.select().from(vatCategories).where(eq(vatCategories.id, foreign)),
    );
    expect(row?.name).toBe('Non-food');
  });
});

describe('setDefaultSupplier converts with the ingredient’s band', () => {
  it('strips 25.5% for an alcohol ingredient, 14% for a food one', async () => {
    // Re-add the alcohol band (the delete test consumed the seeded one).
    const created = await runInOrg(db, ORG_A, (tx) =>
      createVatCategory(tx, ORG_A, { name: 'Alcohol 25.5', rateBps: 2550 }),
    );
    if (created.status !== 'ok') throw new Error('band not created');

    const wine = await newIngredient(ORG_A, 'Red wine');
    const flour = await newIngredient(ORG_A, 'Rye flour');
    const quote = {
      packSize: 1,
      packUnit: 'kg' as const,
      packPriceCents: 10_000,
      priceIncludesVat: true,
      priceBasis: 'pack' as const,
    };

    await runInOrg(db, ORG_A, (tx) =>
      setDefaultSupplier(tx, ORG_A, wine, {
        supplierName: 'Wine Co',
        vatCategoryId: created.category.id,
        ...quote,
      }),
    );
    await runInOrg(db, ORG_A, (tx) =>
      setDefaultSupplier(tx, ORG_A, flour, { supplierName: 'Mill Co', ...quote }),
    );

    // €100 gross → 100 / 1.255 = €79.68 for alcohol, 100 / 1.14 = €87.72 for food.
    const wineRow = await runInOrg(db, ORG_A, (tx) =>
      getIngredientById(tx, ORG_A, wine),
    );
    const flourRow = await runInOrg(db, ORG_A, (tx) =>
      getIngredientById(tx, ORG_A, flour),
    );
    expect(wineRow?.pendingPriceCents).toBe(7968);
    expect(flourRow?.pendingPriceCents).toBe(8772);
    // The band picked in the dialog is persisted on the ingredient.
    expect(wineRow?.vatCategoryId).toBe(created.category.id);
    expect(flourRow?.vatCategoryId).toBeNull();
  });

  it('refuses a gross quote when the org has no band to strip', async () => {
    const ingId = await newIngredient('org_empty', 'Salt');
    const result = await runInOrg(db, 'org_empty', (tx) =>
      setDefaultSupplier(tx, 'org_empty', ingId, {
        supplierName: 'Any Co',
        packSize: 1,
        packUnit: 'kg',
        packPriceCents: 10_000,
        priceIncludesVat: true,
      }),
    );
    expect(result.status).toBe('vat_rate_required');
  });
});
