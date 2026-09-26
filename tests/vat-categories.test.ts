import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { ingredients, vatCategories } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { createIngredient, getIngredientById } from '@/lib/data/ingredients';
import { setDefaultSupplier } from '@/lib/data/ingredient-suppliers';
import { setDefaultPurchaseVat } from '@/lib/data/org-settings';
import {
  createVatCategory,
  deleteVatCategory,
  ensureVatCategories,
  listVatCategories,
  mostCommonPurchaseVatBps,
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
    // No band and no business default purchase VAT: the supplier saves, the gross
    // price can't be read (nothing is invented) and no cost is raised.
    const unknown = await runInOrg(db, ORG_A, (tx) =>
      setDefaultSupplier(tx, ORG_A, flour, { supplierName: 'Mill Co', ...quote }),
    );
    expect(unknown).toMatchObject({ status: 'ok', priceStatus: 'needs_vat' });
    expect((await runInOrg(db, ORG_A, (tx) => getIngredientById(tx, ORG_A, flour)))?.pendingPriceCents).toBeNull();

    // Once the business configures a default purchase VAT, the same quote prices.
    await runInOrg(db, ORG_A, (tx) => setDefaultPurchaseVat(tx, ORG_A, 1400));
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
    expect(wineRow?.priceCents).toBe(7968);
    expect(flourRow?.priceCents).toBe(8772);
    // The band picked in the dialog is persisted on the ingredient.
    expect(wineRow?.vatCategoryId).toBe(created.category.id);
    expect(flourRow?.vatCategoryId).toBeNull();
  });

  it('saves the supplier but not a gross price when no VAT is known anywhere', async () => {
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
    expect(result).toMatchObject({ status: 'ok', priceStatus: 'needs_vat', vatRateBps: null });
    if (result.status === 'ok') expect(result.link.packPriceCents).toBeNull();
  });
});

describe('setDefaultSupplier with a typed VAT rate', () => {
  const grossQuote = {
    packSize: 1,
    packUnit: 'kg' as const,
    packPriceCents: 10_000,
    priceIncludesVat: true,
    priceBasis: 'pack' as const,
  };

  it('uses a typed decimal rate, persists it, and keeps it on later saves', async () => {
    const ingId = await newIngredient(ORG_A, 'Oat drink');
    await runInOrg(db, ORG_A, (tx) =>
      setDefaultSupplier(tx, ORG_A, ingId, { supplierName: 'Oat Co', vatRateBps: 1350, ...grossQuote }),
    );
    let row = await runInOrg(db, ORG_A, (tx) => getIngredientById(tx, ORG_A, ingId));
    expect(row?.vatRateBps).toBe(1350);
    // A deliberate supplier save applies straight to the approved cost — no pending step.
    expect(row?.priceCents).toBe(8811); // 100 / 1.135
    expect(row?.pendingPriceCents).toBeNull();

    // A save that omits the rate leaves it untouched.
    await runInOrg(db, ORG_A, (tx) =>
      setDefaultSupplier(tx, ORG_A, ingId, { supplierName: 'Oat Co', ...grossQuote, packPriceCents: 11_350 }),
    );
    row = await runInOrg(db, ORG_A, (tx) => getIngredientById(tx, ORG_A, ingId));
    expect(row?.vatRateBps).toBe(1350);
    expect(row?.priceCents).toBe(10_000);
  });

  it('treats 0% as a real rate, distinct from unset (which falls back to the business default)', async () => {
    const zero = await newIngredient(ORG_A, 'Export sugar');
    const unset = await newIngredient(ORG_A, 'Local sugar');
    await runInOrg(db, ORG_A, (tx) =>
      setDefaultSupplier(tx, ORG_A, zero, { supplierName: 'Sugar Co', vatRateBps: 0, ...grossQuote }),
    );
    await runInOrg(db, ORG_A, (tx) =>
      setDefaultSupplier(tx, ORG_A, unset, { supplierName: 'Sugar Co', vatRateBps: null, ...grossQuote }),
    );
    const zeroRow = await runInOrg(db, ORG_A, (tx) => getIngredientById(tx, ORG_A, zero));
    const unsetRow = await runInOrg(db, ORG_A, (tx) => getIngredientById(tx, ORG_A, unset));
    expect(zeroRow?.vatRateBps).toBe(0);
    expect(zeroRow?.priceCents).toBe(10_000);
    expect(unsetRow?.vatRateBps).toBeNull();
    expect(unsetRow?.priceCents).toBe(8772); // business default purchase VAT, 14%
  });

  it('rejects out-of-range rates at the database', async () => {
    const ingId = await newIngredient(ORG_A, 'Bad rate');
    await expect(
      runInOrg(db, ORG_A, (tx) =>
        tx.update(ingredients).set({ vatRateBps: 10_001 }).where(eq(ingredients.id, ingId)),
      ),
    ).rejects.toThrow();
  });
});

describe('mostCommonPurchaseVatBps', () => {
  async function setRate(org: string, ingredientId: string, vatRateBps: number | null): Promise<void> {
    await runInOrg(db, org, (tx) =>
      tx.update(ingredients).set({ vatRateBps }).where(eq(ingredients.id, ingredientId)),
    );
  }

  it('returns null when no ingredient has a confirmed rate', async () => {
    const org = 'org_mc_empty';
    await newIngredient(org, 'Unrated 1');
    await newIngredient(org, 'Unrated 2');
    expect(await runInOrg(db, org, (tx) => mostCommonPurchaseVatBps(tx, org))).toBeNull();
  });

  it('picks the rate held by the most ingredients, counting each ingredient once', async () => {
    const org = 'org_mc_majority';
    const a = await newIngredient(org, 'A');
    const b = await newIngredient(org, 'B');
    const c = await newIngredient(org, 'C');
    await newIngredient(org, 'D (unset, excluded)');
    await setRate(org, a, 1350);
    await setRate(org, b, 1350);
    await setRate(org, c, 2550);
    expect(await runInOrg(db, org, (tx) => mostCommonPurchaseVatBps(tx, org))).toBe(1350);
  });

  it('returns null on a tie — no clear majority', async () => {
    const org = 'org_mc_tie';
    const a = await newIngredient(org, 'A');
    const b = await newIngredient(org, 'B');
    await setRate(org, a, 1350);
    await setRate(org, b, 2550);
    expect(await runInOrg(db, org, (tx) => mostCommonPurchaseVatBps(tx, org))).toBeNull();
  });

  it('treats an explicit 0% as a valid, countable rate', async () => {
    const org = 'org_mc_zero';
    const a = await newIngredient(org, 'A');
    const b = await newIngredient(org, 'B');
    const c = await newIngredient(org, 'C');
    await setRate(org, a, 0);
    await setRate(org, b, 0);
    await setRate(org, c, 1350);
    expect(await runInOrg(db, org, (tx) => mostCommonPurchaseVatBps(tx, org))).toBe(0);
  });

  it('never mixes rates across organizations', async () => {
    const orgX = 'org_mc_x';
    const orgY = 'org_mc_y';
    const x = await newIngredient(orgX, 'X');
    await setRate(orgX, x, 1350);
    const y1 = await newIngredient(orgY, 'Y1');
    const y2 = await newIngredient(orgY, 'Y2');
    await setRate(orgY, y1, 2550);
    await setRate(orgY, y2, 2550);
    expect(await runInOrg(db, orgX, (tx) => mostCommonPurchaseVatBps(tx, orgX))).toBe(1350);
    expect(await runInOrg(db, orgY, (tx) => mostCommonPurchaseVatBps(tx, orgY))).toBe(2550);
  });

  it('feeds resolvePurchaseVatBps only when the business has no configured default', async () => {
    const org = 'org_mc_resolve';
    const a = await newIngredient(org, 'A');
    const b = await newIngredient(org, 'B');
    await setRate(org, a, 1350);
    await setRate(org, b, 1350);
    const other = await newIngredient(org, 'Other (no rate, no band)');
    const withoutDefault = await runInOrg(db, org, (tx) =>
      setDefaultSupplier(tx, org, other, {
        supplierName: 'Some Co',
        packSize: 1,
        packUnit: 'kg',
        packPriceCents: 1_135,
        priceIncludesVat: true,
        priceBasis: 'pack',
      }),
    );
    expect(withoutDefault).toMatchObject({ status: 'ok', priceStatus: 'saved', vatRateBps: 1350 });

    // Once the business sets its own default, that wins over the learned majority.
    await runInOrg(db, org, (tx) => setDefaultPurchaseVat(tx, org, 2550));
    const withDefault = await runInOrg(db, org, (tx) =>
      setDefaultSupplier(tx, org, other, {
        supplierName: 'Some Co',
        packSize: 1,
        packUnit: 'kg',
        packPriceCents: 1_255,
        priceIncludesVat: true,
        priceBasis: 'pack',
      }),
    );
    expect(withDefault).toMatchObject({ status: 'ok', vatRateBps: 2550 });
  });
});
