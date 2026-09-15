import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { createIngredient, getIngredientById } from '@/lib/data/ingredients';
import {
  getSupplierProductIdentity,
  loadDefaultLinksByIngredient,
  setDefaultSupplier,
} from '@/lib/data/ingredient-suppliers';
import { ingredientSupplierSchema } from '@/lib/validation/suppliers';
import { setDefaultPurchaseVat } from '@/lib/data/org-settings';

/**
 * The supplier editor's save contract (under `tenant_app`, RLS enforced): a supplier
 * alone saves; every pack / price / VAT field is independently optional; omitted
 * keeps what's stored, null clears to unknown (never 0); an incomplete price never
 * blocks the supplier and never touches the ingredient's approved cost; prices
 * entered per kg or incl. VAT are normalized once; deliberate 0% is remembered.
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

async function ingredient(name: string, priceCents = 0, org = ORG_A) {
  return runInOrg(db, org, async (tx) => (await createIngredient(tx, org, { name, dimension: 'weight', priceCents })).id);
}
const save = (id: string, input: Parameters<typeof setDefaultSupplier>[3], org = ORG_A) =>
  runInOrg(db, org, (tx) => setDefaultSupplier(tx, org, id, input));
const linkOf = async (id: string) =>
  (await runInOrg(db, ORG_A, (tx) => loadDefaultLinksByIngredient(tx, ORG_A, [id]))).get(id) ?? null;

describe('saving a supplier with incomplete information', () => {
  it('saves only a supplier — no pack, price or VAT — and keeps the ingredient cost', async () => {
    const id = await ingredient('Flour', 180);
    const result = await save(id, { supplierName: 'Mill Co' });
    expect(result).toMatchObject({ status: 'ok', priceStatus: 'none', pendingRaised: false });
    expect(await linkOf(id)).toEqual({
      supplierName: 'Mill Co',
      packSize: null,
      packUnit: null,
      packPriceCents: null,
      unitsPerPack: 1,
      supplierProductName: null,
      supplierSku: null,
      vatRateBps: null,
    });
    const row = await runInOrg(db, ORG_A, (tx) => getIngredientById(tx, ORG_A, id));
    expect(row?.priceCents).toBe(180);
    expect(row?.supplier).toBe('Mill Co');
  });

  it('keeps stored pack and price when later saves only change other parts', async () => {
    const id = await ingredient('Butter');
    await save(id, { supplierName: 'Dairy Co', packSize: 2.5, packUnit: 'kg', packPriceCents: 2_000, priceBasis: 'pack' });
    expect((await linkOf(id))?.packPriceCents).toBe(2_000);

    // Only the supplier name again → nothing lost.
    expect(await save(id, { supplierName: 'Dairy Co' })).toMatchObject({ priceStatus: 'unchanged', pendingRaised: false });
    // Only a product name → pack and price kept.
    await save(id, { supplierName: 'Dairy Co', supplierProductName: 'Voi 2,5kg' });
    // Only a deliberate VAT → pack and price kept, VAT remembered.
    await save(id, { supplierName: 'Dairy Co', vatRateBps: 1400 });
    expect(await linkOf(id)).toMatchObject({
      packSize: 2.5,
      packUnit: 'kg',
      packPriceCents: 2_000,
      supplierProductName: 'Voi 2,5kg',
      vatRateBps: 1400,
    });
  });

  it('a new pack without a price makes the old price unknown — never zero — and leaves the cost alone', async () => {
    const id = await ingredient('Sugar', 150);
    await save(id, { supplierName: 'Sweet Co', packSize: 1, packUnit: 'kg', packPriceCents: 150 });
    const result = await save(id, { supplierName: 'Sweet Co', packSize: 25, packUnit: 'kg' });
    expect(result).toMatchObject({ status: 'ok', priceStatus: 'none' });
    expect(await linkOf(id)).toMatchObject({ packSize: 25, packPriceCents: null });
    expect((await runInOrg(db, ORG_A, (tx) => getIngredientById(tx, ORG_A, id)))?.priceCents).toBe(150);
  });

  it('a price without a complete pack still saves the supplier and says what is missing', async () => {
    const id = await ingredient('Salt');
    const result = await save(id, { supplierName: 'Salt Co', packPriceCents: 300 });
    expect(result).toMatchObject({ status: 'ok', priceStatus: 'needs_pack', pendingRaised: false });
    expect((await linkOf(id))?.packPriceCents).toBeNull();
  });

  it('clearing a field stores it as unknown', async () => {
    const id = await ingredient('Cocoa');
    await save(id, { supplierName: 'Cocoa Co', packSize: 1, packUnit: 'kg', packPriceCents: 900, vatRateBps: 1400 });
    await save(id, { supplierName: 'Cocoa Co', packPriceCents: null, vatRateBps: null });
    expect(await linkOf(id)).toMatchObject({ packSize: 1, packPriceCents: null, vatRateBps: null });
  });
});

describe('prices entered per kg and incl. VAT', () => {
  it('stores the pack price from a price per kg, converting grams', async () => {
    const a = await ingredient('Almonds');
    await save(a, { supplierName: 'Nut Co', packSize: 2.5, packUnit: 'kg', packPriceCents: 800, priceBasis: 'priced' });
    expect((await linkOf(a))?.packPriceCents).toBe(2_000); // €8/kg × 2.5 kg

    const b = await ingredient('Pistachios');
    await save(b, { supplierName: 'Nut Co', packSize: 500, packUnit: 'g', packPriceCents: 800, priceBasis: 'priced' });
    expect((await linkOf(b))?.packPriceCents).toBe(400); // €8/kg × 500 g
    expect((await runInOrg(db, ORG_A, (tx) => getIngredientById(tx, ORG_A, b)))?.pendingPriceCents).toBe(800);
  });

  it('removes VAT exactly once, using the entry → ingredient → business default chain', async () => {
    const id = await ingredient('Cream');
    // €8/kg incl. 14% for a 2.5 kg pack → gross €20 → net €17.54.
    const withRate = await save(id, {
      supplierName: 'Dairy Co',
      packSize: 2.5,
      packUnit: 'kg',
      packPriceCents: 800,
      priceBasis: 'priced',
      priceIncludesVat: true,
      vatRateBps: 1400,
    });
    expect(withRate).toMatchObject({ priceStatus: 'saved', vatRateBps: 1400 });
    expect((await linkOf(id))?.packPriceCents).toBe(1_754);

    // Saving the same gross quote again with the remembered rate changes nothing.
    await save(id, { supplierName: 'Dairy Co', packSize: 2.5, packUnit: 'kg', packPriceCents: 800, priceBasis: 'priced', priceIncludesVat: true });
    expect((await linkOf(id))?.packPriceCents).toBe(1_754);

    // Without any rate an incl.-VAT price is not stored (the old one stays for the same pack).
    const noRate = await ingredient('Milk');
    expect(
      await save(noRate, { supplierName: 'Dairy Co', packSize: 1, packUnit: 'kg', packPriceCents: 114, priceIncludesVat: true }),
    ).toMatchObject({ status: 'ok', priceStatus: 'needs_vat' });

    await runInOrg(db, ORG_A, (tx) => setDefaultPurchaseVat(tx, ORG_A, 1400));
    expect(
      await save(noRate, { supplierName: 'Dairy Co', packSize: 1, packUnit: 'kg', packPriceCents: 114, priceIncludesVat: true }),
    ).toMatchObject({ priceStatus: 'saved', vatRateBps: 1400 });
    expect((await linkOf(noRate))?.packPriceCents).toBe(100);
    // The business default is a suggestion — not written onto the entry.
    expect((await linkOf(noRate))?.vatRateBps).toBeNull();
  });

  it('remembers a deliberate 0% over the business default', async () => {
    const id = await ingredient('Export flour');
    await save(id, { supplierName: 'Mill Co', packSize: 1, packUnit: 'kg', packPriceCents: 100, priceIncludesVat: true, vatRateBps: 0 });
    expect(await linkOf(id)).toMatchObject({ vatRateBps: 0, packPriceCents: 100 });
    expect((await runInOrg(db, ORG_A, (tx) => getIngredientById(tx, ORG_A, id)))?.vatRateBps).toBe(0);
  });
});

describe("supplier's product name and code", () => {
  const identity = (id: string, supplierName: string, org = ORG_A) =>
    runInOrg(db, org, (tx) => getSupplierProductIdentity(tx, org, id, supplierName));

  it('keeps codes exactly as typed — letters, leading zeros and punctuation', () => {
    const parsed = ingredientSupplierSchema.parse({ supplierName: 'Mill Co', supplierSku: ' 000123-A/7.5 ' });
    expect(parsed.supplierSku).toBe('000123-A/7.5');
    expect(ingredientSupplierSchema.parse({ supplierName: 'Mill Co', supplierSku: '0042' }).supplierSku).toBe('0042');
  });

  it('stores a separate name and code per supplier for the same ingredient', async () => {
    const id = await ingredient('Cream cheese');
    await save(id, { supplierName: 'Valio', supplierProductName: 'Tuorejuusto 1,5kg', supplierSku: '00417' });
    await save(id, { supplierName: 'Kespro', supplierProductName: 'Cream cheese natural', supplierSku: 'KS-0099' });

    expect(await identity(id, 'Valio')).toEqual({ supplierProductName: 'Tuorejuusto 1,5kg', supplierSku: '00417' });
    expect(await identity(id, 'kespro ')).toEqual({ supplierProductName: 'Cream cheese natural', supplierSku: 'KS-0099' });
    expect(await linkOf(id)).toMatchObject({ supplierName: 'Kespro', supplierSku: 'KS-0099' });

    // Switching back without touching name/code keeps that supplier's own ones.
    await save(id, { supplierName: 'Valio' });
    expect(await linkOf(id)).toMatchObject({ supplierProductName: 'Tuorejuusto 1,5kg', supplierSku: '00417' });
    expect(await identity(id, 'Kespro')).toEqual({ supplierProductName: 'Cream cheese natural', supplierSku: 'KS-0099' });
  });

  it('saves a supplier without name, code or pricing, and never loses a stored pack', async () => {
    const id = await ingredient('Yeast');
    await save(id, { supplierName: 'Baker Co', packSize: 0.5, packUnit: 'kg', packPriceCents: 300 });
    await save(id, { supplierName: 'Baker Co', supplierProductName: 'Hiiva 500g', supplierSku: '0001' });
    expect(await linkOf(id)).toMatchObject({ packSize: 0.5, packPriceCents: 300, supplierSku: '0001' });
    // Clearing the name/code stores unknown, the pack stays.
    await save(id, ingredientSupplierSchema.parse({ supplierName: 'Baker Co', supplierProductName: '', supplierSku: '' }));
    expect(await linkOf(id)).toMatchObject({ packPriceCents: 300, supplierProductName: null, supplierSku: null });
  });

  it('returns null for an unlinked or unknown supplier and hides other organisations', async () => {
    const id = await ingredient('Salt');
    await save(id, { supplierName: 'Salt Co', supplierSku: '007' });
    expect(await identity(id, 'Nobody Ltd')).toBeNull();
    expect(await identity(id, '   ')).toBeNull();
    expect(await identity(id, 'Salt Co', ORG_B)).toBeNull();
  });
});

describe('tenant isolation', () => {
  it('another organisation cannot set a supplier on the ingredient', async () => {
    const id = await ingredient('Private');
    expect((await save(id, { supplierName: 'Intruder Co' }, ORG_B)).status).toBe('not_found');
    expect(await linkOf(id)).toBeNull();
  });
});
