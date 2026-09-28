import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { ingredientPriceHistory, ingredientSuppliers, ingredientUomEquivalencies, suppliers } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { createIngredient, getIngredientById } from '@/lib/data/ingredients';
import { loadDefaultLinksByIngredient } from '@/lib/data/ingredient-suppliers';

/**
 * The unified editor's Save (`updateIngredientEditorAction`) against a real PGlite db
 * as `tenant_app` (RLS on); only auth, db wiring and cache are mocked. Regression for
 * the two reported failures:
 *  1. a directly typed price per kg could not be saved without complete pack details;
 *  2. a pack price could save without updating the ingredient's price per kg.
 */
const ORG = 'org_editor_pricing';
const OTHER_ORG = 'org_editor_pricing_other';

const h = vi.hoisted(() => ({
  db: null as unknown as TenantDb,
  org: 'org_editor_pricing',
  manager: true,
}));

vi.mock('@/lib/auth', () => ({
  getOrgId: vi.fn(async () => h.org),
  isManager: vi.fn(async () => h.manager),
  getUserId: vi.fn(async () => 'user_1'),
  getUserRole: vi.fn(async () => (h.manager ? 'manager' : 'kitchen')),
}));

vi.mock('@/lib/db', async () => {
  const { runInOrg: realRunInOrg } = await import('@/lib/db/tenant');
  return {
    withOrg: (org: string, fn: (tx: never) => unknown) => realRunInOrg(h.db, org, fn as never),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { getSupplierEntryAction, updateIngredientEditorAction } from '@/app/(app)/ingredients/actions';

let client: PGlite;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  h.db = test.db as unknown as TenantDb;
  await h.db.execute(sql.raw('SET ROLE tenant_app;'));
});

afterAll(async () => {
  await h.db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

type Dim = 'weight' | 'volume' | 'count';

async function ingredient(name: string, priceCents = 300, dimension: Dim = 'weight', org = ORG) {
  return runInOrg(h.db, org, async (tx) => (await createIngredient(tx, org, { name, dimension, priceCents })).id);
}

const row = (id: string, org = ORG) => runInOrg(h.db, org, (tx) => getIngredientById(tx, org, id));
const link = async (id: string, org = ORG) =>
  (await runInOrg(h.db, org, (tx) => loadDefaultLinksByIngredient(tx, org, [id]))).get(id) ?? null;
const history = (id: string) =>
  runInOrg(h.db, ORG, (tx) =>
    tx
      .select()
      .from(ingredientPriceHistory)
      .where(and(eq(ingredientPriceHistory.organizationId, ORG), eq(ingredientPriceHistory.ingredientId, id))),
  );
const sql_ = (query: ReturnType<typeof sql>, org = ORG) => runInOrg(h.db, org, (tx) => tx.execute(query));

const save = (id: string, input: Record<string, unknown>) => {
  h.manager = true;
  return updateIngredientEditorAction(id, { dimension: 'weight', ...input });
};

describe('typed price per kg — no pack required (reported failure 1)', () => {
  it('existing ingredient → supplier → €10/kg saves with no pack details and becomes the active cost', async () => {
    const id = await ingredient('Butter', 300);
    const result = await save(id, {
      name: 'Butter',
      supplier: { supplierName: 'Dairy Co', packPriceCents: 1000, priceBasis: 'priced', priceIncludesVat: false },
    });
    expect(result).toMatchObject({ ok: true, data: { supplierChange: { type: 'set', priceStatus: 'saved', priceApplied: true } } });
    expect((await row(id))?.priceCents).toBe(1000);
    expect((await row(id))?.pendingPriceCents).toBeNull();
    expect(await link(id)).toMatchObject({ supplierName: 'Dairy Co', packSize: null, packPriceCents: null });
    const trail = await history(id);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ source: 'manual', accepted: true, derivedPriceCents: 1000, packSize: null });
  });

  it('a direct price per kg with no supplier at all still saves', async () => {
    const id = await ingredient('Sugar', 100);
    expect(await save(id, { name: 'Sugar', priceCents: 1200 })).toMatchObject({ ok: true });
    expect((await row(id))?.priceCents).toBe(1200);
  });

  it('a price per kg with an unusable stored pack (500 ml on a weight ingredient) still saves and keeps the pack', async () => {
    const id = await ingredient('Vanilla extract', 300);
    await save(id, { name: 'Vanilla extract', supplier: { supplierName: 'Spice Co', packSize: 5, packUnit: 'kg', packPriceCents: 500 } });
    await sql_(sql`update ingredient_suppliers set pack_unit = 'ml', pack_size = 500, pack_price_cents = 900 where ingredient_id = ${id}`);

    const result = await save(id, {
      name: 'Vanilla extract',
      supplier: { supplierName: 'Spice Co', packPriceCents: 4000, priceBasis: 'priced', priceIncludesVat: false },
    });
    expect(result).toMatchObject({ ok: true });
    expect((await row(id))?.priceCents).toBe(4000);
    // 500 ml is NOT read as 0.5 kg: the stored pack and its price are untouched.
    expect(await link(id)).toMatchObject({ packSize: 500, packUnit: 'ml', packPriceCents: 900 });
  });
});

describe('pack price reaches the active cost (reported failure 2)', () => {
  it('5 kg for €50 stores €10/kg as the ingredient cost', async () => {
    const id = await ingredient('Flour', 300);
    const result = await save(id, {
      name: 'Flour',
      supplier: { supplierName: 'Mill Co', unitsPerPack: 1, packSize: 5, packUnit: 'kg', packPriceCents: 5000, priceBasis: 'pack', priceIncludesVat: false },
    });
    expect(result).toMatchObject({ ok: true, data: { supplierChange: { priceApplied: true } } });
    expect((await row(id))?.priceCents).toBe(1000);
    expect(await link(id)).toMatchObject({ packSize: 5, packUnit: 'kg', packPriceCents: 5000 });
    const [entry] = await history(id);
    expect(entry).toMatchObject({ packUnit: 'kg', packPriceCents: 5000, derivedPriceCents: 1000 });
    expect(Number(entry?.packSize)).toBe(5);
  });

  it('re-saving an unchanged pack heals an active cost that drifted from it', async () => {
    const id = await ingredient('Almond flour', 300);
    const supplier = { supplierName: 'Nut Co', unitsPerPack: 1, packSize: 25, packUnit: 'kg', packPriceCents: 35_000, priceBasis: 'pack', priceIncludesVat: false };
    await save(id, { name: 'Almond flour', supplier });
    await sql_(sql`update ingredients set price_cents = 300 where id = ${id}`);

    const again = await save(id, { name: 'Almond flour', supplier });
    expect(again).toMatchObject({ ok: true, data: { supplierChange: { priceApplied: true } } });
    expect((await row(id))?.priceCents).toBe(1400); // €350 / 25 kg
  });

  it('€10/kg with a 5 kg pack calculates the €50 pack price', async () => {
    const id = await ingredient('Rice', 100);
    await save(id, {
      name: 'Rice',
      supplier: { supplierName: 'Grain Co', unitsPerPack: 1, packSize: 5, packUnit: 'kg', packPriceCents: 1000, priceBasis: 'priced', priceIncludesVat: false },
    });
    expect((await row(id))?.priceCents).toBe(1000);
    expect(await link(id)).toMatchObject({ packPriceCents: 5000 });
  });

  it('a pack price without a pack size is refused with an actionable code, saving nothing', async () => {
    const id = await ingredient('Oats', 250);
    const result = await save(id, { name: 'Oats renamed', supplier: { supplierName: 'Grain Co', packPriceCents: 900, priceBasis: 'pack' } });
    expect(result).toEqual({ ok: false, code: 'PACK_REQUIRED_FOR_PRICE' });
    expect((await row(id))?.name).toBe('Oats');
    expect((await row(id))?.priceCents).toBe(250);
    expect(await link(id)).toBeNull();
    expect(await history(id)).toHaveLength(0);
  });
});

describe('VAT is applied once and never assumed', () => {
  it('€60 including a chosen 20% VAT for 5 kg gives €10/kg excluding VAT', async () => {
    const id = await ingredient('Chocolate', 300);
    await save(id, {
      name: 'Chocolate',
      supplier: {
        supplierName: 'Cocoa Co',
        unitsPerPack: 1,
        packSize: 5,
        packUnit: 'kg',
        packPriceCents: 6000,
        priceBasis: 'pack',
        priceIncludesVat: true,
        vatRateBps: 2000,
      },
    });
    expect((await row(id))?.priceCents).toBe(1000);
    expect(await link(id)).toMatchObject({ packPriceCents: 5000, vatRateBps: 2000 });
  });

  it('the same net cost results whether entered excl. €50 or incl. €60 at 20%', async () => {
    const a = await ingredient('Excl entry', 300);
    const b = await ingredient('Incl entry', 300);
    const pack = { unitsPerPack: 1, packSize: 5, packUnit: 'kg' };
    await save(a, { name: 'Excl entry', supplier: { supplierName: 'Co', ...pack, packPriceCents: 5000, priceBasis: 'pack', priceIncludesVat: false } });
    await save(b, { name: 'Incl entry', supplier: { supplierName: 'Co', ...pack, packPriceCents: 6000, priceBasis: 'pack', priceIncludesVat: true, vatRateBps: 2000 } });
    expect((await row(a))?.priceCents).toBe((await row(b))?.priceCents);
  });

  it('a price including VAT with no rate anywhere is refused and writes nothing', async () => {
    // A fresh org: here no rate is stored anywhere, so the "most common rate" fallback is empty.
    const NO_VAT_ORG = 'org_editor_pricing_novat';
    const id = await ingredient('Salt', 120, 'weight', NO_VAT_ORG);
    const suppliersBefore = await runInOrg(h.db, NO_VAT_ORG, async (tx) => (await tx.select().from(suppliers)).length);

    h.org = NO_VAT_ORG;
    const result = await save(id, {
      name: 'Salt renamed',
      supplier: { supplierName: 'Brand New Supplier', unitsPerPack: 1, packSize: 1, packUnit: 'kg', packPriceCents: 6000, priceBasis: 'pack', priceIncludesVat: true },
    });
    h.org = ORG;

    expect(result).toEqual({ ok: false, code: 'VAT_RATE_REQUIRED' });
    expect(await row(id, NO_VAT_ORG)).toMatchObject({ name: 'Salt', priceCents: 120 });
    // The whole transaction rolled back: not even the new supplier was created.
    const suppliersAfter = await runInOrg(h.db, NO_VAT_ORG, async (tx) => (await tx.select().from(suppliers)).length);
    expect(suppliersAfter).toBe(suppliersBefore);
    expect(await link(id, NO_VAT_ORG)).toBeNull();
  });

  it('a direct price including VAT is netted once with the supplied rate', async () => {
    const id = await ingredient('Cream', 100);
    expect(await save(id, { name: 'Cream', priceCents: 1200, priceIncludesVat: true, priceVatRateBps: 2000 })).toMatchObject({ ok: true });
    expect((await row(id))?.priceCents).toBe(1000);
  });
});

describe('multipacks, units and equivalencies', () => {
  it('4 × 1.65 kg for €66 works out €10/kg (units × size, unambiguous total)', async () => {
    const id = await ingredient('Cream case', 100);
    await save(id, {
      name: 'Cream case',
      supplier: { supplierName: 'Dairy Co', unitsPerPack: 4, packSize: 1.65, packUnit: 'kg', packPriceCents: 6600, priceBasis: 'pack' },
    });
    expect((await row(id))?.priceCents).toBe(1000);
    expect(await link(id)).toMatchObject({ unitsPerPack: 4, packSize: 1.65, packPriceCents: 6600 });
  });

  it('a 500 ml pack on a weight ingredient is never priced as 500 g without an equivalency', async () => {
    const id = await ingredient('Cream 500ml', 300);
    await save(id, { name: 'Cream 500ml', supplier: { supplierName: 'Dairy Co', packSize: 1, packUnit: 'kg', packPriceCents: 300 } });
    await sql_(sql`update ingredient_suppliers set pack_unit = 'ml', pack_size = 500 where ingredient_id = ${id}`);

    const result = await save(id, {
      name: 'Cream 500ml',
      supplier: { supplierName: 'Dairy Co', packPriceCents: 450, priceBasis: 'pack' },
    });
    expect(result).toEqual({ ok: false, code: 'PACK_NEEDS_EQUIVALENCY' });
    expect((await row(id))?.priceCents).toBe(300);
  });

  it('converts a volume pack only through the ingredient’s own equivalency', async () => {
    const id = await ingredient('Honey', 300);
    await save(id, { name: 'Honey', supplier: { supplierName: 'Bee Co', packSize: 1, packUnit: 'kg', packPriceCents: 300 } });
    await sql_(sql`update ingredient_suppliers set pack_unit = 'ml', pack_size = 500 where ingredient_id = ${id}`);
    // 500 ml of honey weighs 700 g.
    await runInOrg(h.db, ORG, (tx) =>
      tx.insert(ingredientUomEquivalencies).values({ organizationId: ORG, ingredientId: id, weightGrams: 700, volumeMl: 500 }),
    );

    const result = await save(id, { name: 'Honey', supplier: { supplierName: 'Bee Co', packPriceCents: 700, priceBasis: 'pack' } });
    expect(result).toMatchObject({ ok: true });
    expect((await row(id))?.priceCents).toBe(1000); // €7.00 / 0.7 kg
  });

  it('refuses to newly pick a pack unit of the wrong kind', async () => {
    const id = await ingredient('Pepper', 300);
    const result = await save(id, { name: 'Pepper', supplier: { supplierName: 'Spice Co', packSize: 500, packUnit: 'ml', packPriceCents: 500 } });
    expect(result).toEqual({ ok: false, code: 'PACK_UNIT_MISMATCH' });
  });
});

describe('supplier switching, metadata edits and missing vs zero', () => {
  it('keeps the other supplier’s pack and price, and each supplier’s entry is loadable', async () => {
    const id = await ingredient('Eggs', 300);
    const pack = { unitsPerPack: 1, packSize: 5, packUnit: 'kg', priceBasis: 'pack' };
    await save(id, { name: 'Eggs', supplier: { supplierName: 'Farm A', ...pack, packPriceCents: 5000 } });
    await save(id, { name: 'Eggs', supplier: { supplierName: 'Farm B', ...pack, packPriceCents: 7000 } });

    expect((await row(id))?.priceCents).toBe(1400);
    expect(await link(id)).toMatchObject({ supplierName: 'Farm B' });
    const a = await getSupplierEntryAction(id, 'Farm A');
    expect(a).toMatchObject({ ok: true, data: { supplierName: 'Farm A', packSize: 5, packPriceCents: 5000 } });
    const none = await getSupplierEntryAction(id, 'Farm C');
    expect(none).toEqual({ ok: true, data: null });
  });

  it('a name/notes/supplier-name edit sends no price and changes no price', async () => {
    const id = await ingredient('Milk', 300);
    await save(id, { name: 'Milk', supplier: { supplierName: 'Dairy Co', packSize: 1, packUnit: 'kg', packPriceCents: 150, priceBasis: 'pack' } });
    await sql_(sql`update ingredients set pending_price_cents = 999 where id = ${id}`);
    const before = await history(id);

    const result = await save(id, { name: 'Whole milk', notes: 'Order Tuesdays', supplier: { supplierName: 'Dairy Co' } });
    expect(result).toMatchObject({ ok: true });
    const after = await row(id);
    expect(after).toMatchObject({ name: 'Whole milk', notes: 'Order Tuesdays', priceCents: 150, pendingPriceCents: 999 });
    expect(await link(id)).toMatchObject({ packSize: 1, packPriceCents: 150 });
    expect(await history(id)).toHaveLength(before.length);
  });

  it('a manual price supersedes an imported pending cost', async () => {
    const id = await ingredient('Cocoa', 300);
    await sql_(sql`update ingredients set pending_price_cents = 999 where id = ${id}`);
    await save(id, { name: 'Cocoa', supplier: { supplierName: 'Co', packPriceCents: 800, priceBasis: 'priced' } });
    expect(await row(id)).toMatchObject({ priceCents: 800, pendingPriceCents: null });
  });

  it('clearing the pack price makes it unknown, never zero, and leaves the active cost alone', async () => {
    const id = await ingredient('Yeast', 300);
    await save(id, { name: 'Yeast', supplier: { supplierName: 'Baker Co', packSize: 1, packUnit: 'kg', packPriceCents: 900, priceBasis: 'pack' } });
    await save(id, { name: 'Yeast', supplier: { supplierName: 'Baker Co', packPriceCents: null } });
    expect(await link(id)).toMatchObject({ packSize: 1, packPriceCents: null });
    expect((await row(id))?.priceCents).toBe(900);
  });

  it('a deliberate €0 price is stored as 0 while an omitted price changes nothing', async () => {
    const zero = await ingredient('Free sample', 300);
    const omitted = await ingredient('Untouched', 300);
    await save(zero, { name: 'Free sample', supplier: { supplierName: 'Co', packPriceCents: 0, priceBasis: 'priced' } });
    await save(omitted, { name: 'Untouched', supplier: { supplierName: 'Co' } });
    expect((await row(zero))?.priceCents).toBe(0);
    expect((await row(omitted))?.priceCents).toBe(300);
  });
});

describe('permissions and tenant isolation', () => {
  it('kitchen users get FORBIDDEN before any data access', async () => {
    const id = await ingredient('Kitchen target', 300);
    h.manager = false;
    const result = await updateIngredientEditorAction(id, { name: 'X', dimension: 'weight', priceCents: 1 });
    h.manager = true;
    expect(result).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect((await row(id))?.priceCents).toBe(300);
  });

  it('another organisation cannot edit the ingredient', async () => {
    const id = await ingredient('Private', 300);
    h.org = OTHER_ORG;
    const result = await save(id, { name: 'Hijacked', priceCents: 1 });
    h.org = ORG;
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await row(id)).toMatchObject({ name: 'Private', priceCents: 300 });
  });

  it('links stay org-scoped: the other org sees no supplier entry', async () => {
    const id = await ingredient('Scoped', 300);
    await save(id, { name: 'Scoped', supplier: { supplierName: 'Only Ours' } });
    h.org = OTHER_ORG;
    const entry = await getSupplierEntryAction(id, 'Only Ours');
    h.org = ORG;
    expect(entry).toEqual({ ok: true, data: null });
    const rows = await runInOrg(h.db, OTHER_ORG, (tx) => tx.select().from(ingredientSuppliers));
    expect(rows).toHaveLength(0);
  });
});
