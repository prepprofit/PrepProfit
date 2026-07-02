import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { saleItems, sales } from '@/lib/db/schema';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import { loadCfoReport } from '@/lib/data/cfo-report';

/**
 * Weekly CFO Report data-loader tests (Sprint 8, Slice 8.2). Cover the two-week trend
 * bucketing, posted-only + org isolation, partial food cost, supplier price changes, low
 * stock, and the empty state. Each case gets its own org so assertions never cross-pollute.
 */

const WEEK_TO = '2026-06-30'; // this week = [06-24..06-30], prior = [06-17..06-23]

/** A priced recipe costing 1000 c/portion (1000 g of a 1000 c/kg ingredient). */
async function pricedRecipe(db: TenantDb, org: string, name: string) {
  const ing = await createIngredient(db, org, {
    name: `${name} ingredient`,
    dimension: 'weight',
    priceCents: 1000,
    needsPricing: false,
  });
  const recipe = await createRecipe(db, org, { name, sellingPriceCents: 3000 });
  const added = await addRecipeIngredient(db, org, {
    recipeId: recipe.id,
    ingredientId: ing.id,
    quantity: 1000,
  });
  if (!added.ok) throw new Error('failed to add recipe line');
  return recipe;
}

/** Insert a sale header (frozen totals) + one recipe line at `units`. */
async function insertRecipeSale(
  db: TenantDb,
  org: string,
  opts: {
    date: string;
    status: 'draft' | 'posted' | 'void';
    recipeId: string;
    name: string;
    units: number;
    grossCents: number;
    netCents: number;
  },
) {
  const terminal = opts.status !== 'draft';
  const [sale] = await db
    .insert(sales)
    .values({
      organizationId: org,
      saleDate: opts.date,
      status: opts.status,
      netCents: terminal ? opts.netCents : null,
      taxCents: terminal ? opts.grossCents - opts.netCents : null,
      grossCents: terminal ? opts.grossCents : null,
      postedAt: terminal ? new Date() : null,
      voidedAt: opts.status === 'void' ? new Date() : null,
    })
    .returning();
  if (!sale) throw new Error('failed to insert sale');
  await db.insert(saleItems).values({
    organizationId: org,
    saleId: sale.id,
    itemKind: 'recipe',
    itemRecipeId: opts.recipeId,
    itemMenuId: null,
    itemIngredientId: null,
    itemName: opts.name,
    quantity: opts.units,
    ingredientQtyCanonical: null,
    unitNetCents: 100,
    taxRateBps: 0,
    netCents: 100 * opts.units,
    taxCents: 0,
    grossCents: 100 * opts.units,
  });
}

describe('loadCfoReport', () => {
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

  it('buckets posted sales into this vs prior week and computes both trends', async () => {
    const org = 'org_trend';
    const recipe = await pricedRecipe(db, org, 'Steak');
    // Prior week: gross 10000, net 8000, 4 units → food cost 4000 → 50%.
    await insertRecipeSale(db, org, {
      date: '2026-06-20',
      status: 'posted',
      recipeId: recipe.id,
      name: 'Steak',
      units: 4,
      grossCents: 10_000,
      netCents: 8_000,
    });
    // This week: gross 12000, net 10000, 3 units → food cost 3000 → 30%.
    await insertRecipeSale(db, org, {
      date: '2026-06-28',
      status: 'posted',
      recipeId: recipe.id,
      name: 'Steak',
      units: 3,
      grossCents: 12_000,
      netCents: 10_000,
    });

    const report = await db.transaction((tx) => loadCfoReport(tx, org, WEEK_TO));

    expect(report.revenue.thisWeekGrossCents).toBe(12_000);
    expect(report.revenue.priorWeekGrossCents).toBe(10_000);
    expect(report.revenue.changePercent).toBe(20);
    expect(report.foodCost.thisWeekPercent).toBe(30);
    expect(report.foodCost.priorWeekPercent).toBe(50);
    expect(report.foodCost.changePoints).toBe(-20);
    expect(report.foodCost.thisWeekComplete).toBe(true);
    expect(report.hasData).toBe(true);
  });

  it('ignores draft/void sales and other orgs', async () => {
    const org = 'org_iso';
    const other = 'org_other';
    const recipe = await pricedRecipe(db, org, 'Steak');
    await insertRecipeSale(db, org, {
      date: '2026-06-28',
      status: 'posted',
      recipeId: recipe.id,
      name: 'Steak',
      units: 3,
      grossCents: 12_000,
      netCents: 10_000,
    });
    // Draft + void in the same week — must not count.
    await insertRecipeSale(db, org, {
      date: '2026-06-27',
      status: 'draft',
      recipeId: recipe.id,
      name: 'Steak',
      units: 99,
      grossCents: 99_000,
      netCents: 99_000,
    });
    await insertRecipeSale(db, org, {
      date: '2026-06-26',
      status: 'void',
      recipeId: recipe.id,
      name: 'Steak',
      units: 99,
      grossCents: 99_000,
      netCents: 99_000,
    });
    // Another org's posted sale — must not leak in.
    const otherRecipe = await pricedRecipe(db, other, 'Steak');
    await insertRecipeSale(db, other, {
      date: '2026-06-28',
      status: 'posted',
      recipeId: otherRecipe.id,
      name: 'Steak',
      units: 50,
      grossCents: 50_000,
      netCents: 50_000,
    });

    const report = await db.transaction((tx) => loadCfoReport(tx, org, WEEK_TO));
    expect(report.revenue.thisWeekGrossCents).toBe(12_000);
    expect(report.foodCost.thisWeekPercent).toBe(30);
  });

  it('marks the week partial when a sold item has no resolvable cost', async () => {
    const org = 'org_partial';
    // An unpriced recipe: its ingredient needs pricing, so the cost is untrue → null.
    const ing = await createIngredient(db, org, {
      name: 'Mystery',
      dimension: 'weight',
      priceCents: 0,
      needsPricing: true,
    });
    const recipe = await createRecipe(db, org, { name: 'Special', sellingPriceCents: 2000 });
    const added = await addRecipeIngredient(db, org, {
      recipeId: recipe.id,
      ingredientId: ing.id,
      quantity: 1000,
    });
    if (!added.ok) throw new Error('failed to add line');
    await insertRecipeSale(db, org, {
      date: '2026-06-28',
      status: 'posted',
      recipeId: recipe.id,
      name: 'Special',
      units: 3,
      grossCents: 6_000,
      netCents: 5_000,
    });

    const report = await db.transaction((tx) => loadCfoReport(tx, org, WEEK_TO));
    expect(report.foodCost.thisWeekPercent).toBeNull();
    expect(report.foodCost.thisWeekComplete).toBe(false);
    expect(report.confidence.map((c) => c.code)).toContain('PARTIAL_FOOD_COST');
    expect(report.confidence.map((c) => c.code)).toContain('UNPRICED_INGREDIENTS');
  });

  it('surfaces a pending supplier price change and low stock', async () => {
    const org = 'org_supply';
    await createIngredient(db, org, {
      name: 'Butter',
      dimension: 'weight',
      priceCents: 1_000,
      pendingPriceCents: 1_250,
      needsPricing: false,
      stockQuantity: '50',
      lowStockThreshold: '200',
    });

    const report = await db.transaction((tx) => loadCfoReport(tx, org, WEEK_TO));
    expect(report.supplierPriceChanges).toHaveLength(1);
    expect(report.supplierPriceChanges[0]?.fromCents).toBe(1_000);
    expect(report.supplierPriceChanges[0]?.toCents).toBe(1_250);
    expect(report.supplierPriceChanges[0]?.changePercent).toBe(25);
    expect(report.lowStock).toHaveLength(1);
    expect(report.lowStock[0]?.name).toBe('Butter');
  });

  it('returns an empty report (hasData=false) when there is nothing to report', async () => {
    const org = 'org_empty';
    const report = await db.transaction((tx) => loadCfoReport(tx, org, WEEK_TO));
    expect(report.hasData).toBe(false);
    expect(report.confidence.map((c) => c.code)).toContain('NO_SALES_THIS_WEEK');
  });
});
