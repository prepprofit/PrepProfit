import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { profitSettings, recipes as recipesTable } from '@/lib/db/schema';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe, softDeleteRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import { loadDefaultPortionPrices } from '@/lib/data/recipe-portion-options';
import {
  getProfitSettingsRow,
  loadProfitProducts,
  toHourlyRateInput,
  updateProductProfit,
  upsertProfitSettings,
} from '@/lib/data/profit';
import { trueHourlyRate } from '@/lib/calculations/profit-hour';
import { profitForProduct } from '@/lib/profit/product';
import type { ProductProfitFormInput, ProfitSettingsInput } from '@/lib/validation/profit';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

const SETTINGS: ProfitSettingsInput = {
  rentCents: 120_000,
  equipmentLeasesCents: 0,
  equipmentDepreciationCents: 10_000,
  insuranceLicensesCents: 5_000,
  utilitiesCents: 15_000,
  salariedStaffCents: 50_000,
  softwareCents: 0,
  productiveHoursPerMonth: 100,
  ownerTargetIncomePerHourCents: 1_500,
  subletEnabled: false,
  subletIngredientMultiplierBps: 14_000,
};

const PROFIT_INPUT: ProductProfitFormInput = {
  batchTimeMinutes: 60,
  batchYield: 12,
  saleUnit: 'piece',
  sellingPriceCents: 500,
  packagingPerBatchCents: 240,
  energyPerBatchCents: 120,
  deliveryPerUnitCents: 30,
  wasteBps: 1_000,
  extraStepMinutes: null,
  extraStepPriceCents: null,
};

/** Recipe whose single `count` line costs €12 per batch, 12 portions. */
async function makeRecipe(db: TenantDb, org: string, name: string, needsPricing = false) {
  const ing = await createIngredient(db, org, {
    name: `${name} ingredient`,
    dimension: 'count',
    priceCents: 1_200,
  });
  if (needsPricing) {
    await db.execute(sql`UPDATE ingredients SET needs_pricing = true WHERE id = ${ing.id}`);
  }
  const recipe = await createRecipe(db, org, { name, yieldPortions: 12 });
  const added = await addRecipeIngredient(db, org, {
    recipeId: recipe.id,
    ingredientId: ing.id,
    quantity: 1,
  });
  if (!added.ok) throw new Error('failed to add line');
  return recipe;
}

describe('profit data layer', () => {
  let client: PGlite;
  let db: TenantDb;

  beforeEach(async () => {
    const test = await createTestDb();
    client = test.client;
    db = test.db;
  });

  afterEach(async () => {
    await client.close();
  });

  it('upserts settings once per org and derives the rate from the row', async () => {
    expect(toHourlyRateInput(await getProfitSettingsRow(db, ORG_A))).toBeNull();

    await upsertProfitSettings(db, ORG_A, SETTINGS);
    await upsertProfitSettings(db, ORG_A, { ...SETTINGS, ownerTargetIncomePerHourCents: 2_000 });

    const row = await getProfitSettingsRow(db, ORG_A);
    const rate = trueHourlyRate(toHourlyRateInput(row)!);
    // (1200 + 100 + 50 + 150 + 500) € / 100 h = €20/h + €20/h owner.
    expect(rate?.fixedCostPerHourCents).toBe(2_000);
    expect(rate?.trueHourlyRateCents).toBe(4_000);
    expect(await getProfitSettingsRow(db, ORG_B)).toBeNull();
  });

  it('rejects out-of-range settings at the DB layer', async () => {
    await expect(
      upsertProfitSettings(db, ORG_A, { ...SETTINGS, productiveHoursPerMonth: 800 }),
    ).rejects.toThrow();
    await expect(upsertProfitSettings(db, ORG_A, { ...SETTINGS, rentCents: -1 })).rejects.toThrow();
  });

  it('loads products with honest ingredient cost and missing-data markers', async () => {
    const priced = await makeRecipe(db, ORG_A, 'Croissant');
    const unpriced = await makeRecipe(db, ORG_A, 'Tart', true);
    await makeRecipe(db, ORG_B, 'Other org');

    const products = await loadProfitProducts(db, ORG_A);
    expect(products.map((p) => p.name).sort()).toEqual(['Croissant', 'Tart']);

    const croissant = products.find((p) => p.id === priced.id)!;
    expect(croissant.ingredientCostPerBatchCents).toBe(1_200);
    expect(croissant.batchYield).toBe(12);
    expect(croissant.missing).toEqual(['batchTime', 'price']);
    expect(profitForProduct(croissant, null)).toBeNull();

    const tart = products.find((p) => p.id === unpriced.id)!;
    expect(tart.ingredientCostPerBatchCents).toBeNull();
    expect(tart.missing).toContain('ingredientPricing');
  });

  it('saves profit inputs, bumps the version and syncs a changed price', async () => {
    const recipe = await makeRecipe(db, ORG_A, 'Croissant');
    const before = recipe.version;

    const result = await updateProductProfit(db, ORG_A, recipe.id, PROFIT_INPUT);
    expect(result).toMatchObject({ status: 'done', priceChanged: true });
    if (result.status === 'done') {
      expect(result.changedFields).toEqual(
        expect.arrayContaining(['batchTimeMinutes', 'packagingCostCents', 'wasteBps']),
      );
    }

    const [row] = await db.select().from(recipesTable).where(eq(recipesTable.id, recipe.id));
    expect(row?.version).toBe(before + 1);
    expect(row?.batchTimeMinutes).toBe(60);
    expect(row?.saleUnit).toBe('piece');
    expect((await loadDefaultPortionPrices(db, ORG_A, [recipe.id])).get(recipe.id)).toBe(500);

    await upsertProfitSettings(db, ORG_A, SETTINGS);
    const rate = trueHourlyRate(toHourlyRateInput(await getProfitSettingsRow(db, ORG_A))!);
    const product = (await loadProfitProducts(db, ORG_A)).find((p) => p.id === recipe.id)!;
    expect(product.missing).toEqual([]);
    const profit = profitForProduct(product, rate);
    // variable = 100 × 1.1 + 20 + 10 + 30 = 170 → (500 − 170) × 12 = €39.60/h
    expect(profit?.euroPerHourCents).toBe(3_960);
    // Rate = €20/h fixed + €15/h owner = €35/h → at or above the rate = solid.
    expect(profit?.verdict).toBe('solid');

    // An identical save is a no-op: no version bump.
    const again = await updateProductProfit(db, ORG_A, recipe.id, PROFIT_INPUT);
    expect(again).toEqual({ status: 'done', changedFields: [], priceChanged: false });
    const [unchanged] = await db.select().from(recipesTable).where(eq(recipesTable.id, recipe.id));
    expect(unchanged?.version).toBe(before + 1);
  });

  it('returns not_found for another org’s or a trashed recipe', async () => {
    const foreign = await makeRecipe(db, ORG_B, 'Foreign');
    expect(await updateProductProfit(db, ORG_A, foreign.id, PROFIT_INPUT)).toEqual({
      status: 'not_found',
    });

    const trashed = await makeRecipe(db, ORG_A, 'Trashed');
    await softDeleteRecipe(db, ORG_A, trashed.id);
    expect(await updateProductProfit(db, ORG_A, trashed.id, PROFIT_INPUT)).toEqual({
      status: 'not_found',
    });
    expect((await loadProfitProducts(db, ORG_A)).map((p) => p.id)).not.toContain(trashed.id);
  });
});

describe('profit_settings RLS (tenant_app role)', () => {
  let client: PGlite;
  let db: TenantDb;

  beforeEach(async () => {
    const test = await createTestDb();
    client = test.client;
    db = test.db;
    // Seed as superuser (bypasses RLS).
    await upsertProfitSettings(db, ORG_A, SETTINGS);
  });

  afterEach(async () => {
    await db.execute(sql.raw('RESET ROLE;'));
    await client.close();
  });

  it('isolates SELECT, INSERT, UPDATE retag and DELETE by org', async () => {
    await db.execute(sql.raw('SET ROLE tenant_app;'));

    // SELECT: an unfiltered read only sees the active org.
    const seenByB = await runInOrg(db, ORG_B, (tx) => tx.select().from(profitSettings));
    expect(seenByB).toHaveLength(0);
    const seenByA = await runInOrg(db, ORG_A, (tx) => tx.select().from(profitSettings));
    expect(seenByA).toHaveLength(1);

    // INSERT WITH CHECK: org B cannot write a row tagged for org C.
    await expect(
      runInOrg(db, ORG_B, (tx) =>
        tx.insert(profitSettings).values({ organizationId: 'org_c', rentCents: 1 }),
      ),
    ).rejects.toThrow();

    // UPDATE: org B cannot reach org A's row; org A cannot retag its row away.
    const updatedByB = await runInOrg(db, ORG_B, (tx) =>
      tx.update(profitSettings).set({ rentCents: 1 }).returning(),
    );
    expect(updatedByB).toHaveLength(0);
    await expect(
      runInOrg(db, ORG_A, (tx) =>
        tx.update(profitSettings).set({ organizationId: ORG_B }).returning(),
      ),
    ).rejects.toThrow();

    // DELETE: org B's unfiltered delete removes nothing of org A's.
    const deletedByB = await runInOrg(db, ORG_B, (tx) =>
      tx.delete(profitSettings).returning(),
    );
    expect(deletedByB).toHaveLength(0);

    await db.execute(sql.raw('RESET ROLE;'));
    const [row] = await db.select().from(profitSettings);
    expect(row?.organizationId).toBe(ORG_A);
    expect(row?.rentCents).toBe(120_000);
  });
});
