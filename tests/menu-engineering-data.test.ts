import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { saleItems, sales } from '@/lib/db/schema';
import type { SaleItemKind, SaleStatus } from '@/lib/db/schema';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import { createMenu } from '@/lib/data/menus';
import { loadMenuEngineering } from '@/lib/data/menu-engineering';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const PERIOD = { from: '2026-06-01', to: '2026-06-30' };

/**
 * Insert a sale + one line directly (bypassing the full post flow — we only need the
 * aggregation shape). Terminal sales (posted/void) carry frozen money + posted_at to
 * satisfy the schema CHECKs; a void also carries voided_at.
 */
async function insertSale(
  db: TenantDb,
  org: string,
  opts: {
    date: string;
    status: SaleStatus;
    kind: SaleItemKind;
    refId: string;
    name: string;
    units: number;
  },
) {
  const terminal = opts.status !== 'draft';
  const [sale] = await db
    .insert(sales)
    .values({
      organizationId: org,
      saleDate: opts.date,
      status: opts.status,
      netCents: terminal ? 1000 : null,
      taxCents: terminal ? 0 : null,
      grossCents: terminal ? 1000 : null,
      postedAt: terminal ? new Date() : null,
      voidedAt: opts.status === 'void' ? new Date() : null,
    })
    .returning();
  if (!sale) throw new Error('failed to insert sale');
  await db.insert(saleItems).values({
    organizationId: org,
    saleId: sale.id,
    itemKind: opts.kind,
    itemRecipeId: opts.kind === 'recipe' ? opts.refId : null,
    itemMenuId: opts.kind === 'menu' ? opts.refId : null,
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

/** A priced recipe: 1000 g of a 1000 c/kg ingredient → 1000 c/portion cost. */
async function pricedRecipe(
  db: TenantDb,
  org: string,
  name: string,
  sellingPriceCents: number | null,
) {
  const ing = await createIngredient(db, org, {
    name: `${name} ingredient`,
    dimension: 'weight',
    priceCents: 1000,
    needsPricing: false,
  });
  const recipe = await createRecipe(db, org, { name, sellingPriceCents });
  const added = await addRecipeIngredient(db, org, {
    recipeId: recipe.id,
    ingredientId: ing.id,
    quantity: 1000,
  });
  if (!added.ok) throw new Error('failed to add recipe line');
  return recipe;
}

describe('loadMenuEngineering', () => {
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

  it('counts only posted sales inside the period, scoped to the org', async () => {
    const recipe = await pricedRecipe(db, ORG_A, 'Steak', 3000);

    // Counted: one posted sale of 5 units in the window.
    await insertSale(db, ORG_A, {
      date: '2026-06-10',
      status: 'posted',
      kind: 'recipe',
      refId: recipe.id,
      name: 'Steak',
      units: 5,
    });
    // Ignored: a void, a draft, and a posted sale OUTSIDE the window.
    await insertSale(db, ORG_A, {
      date: '2026-06-11',
      status: 'void',
      kind: 'recipe',
      refId: recipe.id,
      name: 'Steak',
      units: 100,
    });
    await insertSale(db, ORG_A, {
      date: '2026-06-12',
      status: 'draft',
      kind: 'recipe',
      refId: recipe.id,
      name: 'Steak',
      units: 100,
    });
    await insertSale(db, ORG_A, {
      date: '2026-05-01',
      status: 'posted',
      kind: 'recipe',
      refId: recipe.id,
      name: 'Steak',
      units: 100,
    });

    // Another org sells the same-ish recipe far more — must never leak in.
    const otherRecipe = await pricedRecipe(db, ORG_B, 'Steak B', 3000);
    await insertSale(db, ORG_B, {
      date: '2026-06-10',
      status: 'posted',
      kind: 'recipe',
      refId: otherRecipe.id,
      name: 'Steak B',
      units: 999,
    });

    const result = await loadMenuEngineering(db, ORG_A, PERIOD);

    expect(result.classified).toHaveLength(1);
    expect(result.classified[0]!.id).toBe(recipe.id);
    expect(result.classified[0]!.kind).toBe('recipe');
    expect(result.classified[0]!.unitsSold).toBe(5);
    expect(result.classified[0]!.costCents).toBe(1000);
    expect(result.classified[0]!.class).toBe('star'); // lone classified item
    expect(result.totalUnitsSold).toBe(5);
  });

  it('sums units across multiple posted sales of the same item', async () => {
    const recipe = await pricedRecipe(db, ORG_A, 'Soup', 2000);
    await insertSale(db, ORG_A, {
      date: '2026-06-05',
      status: 'posted',
      kind: 'recipe',
      refId: recipe.id,
      name: 'Soup',
      units: 4,
    });
    await insertSale(db, ORG_A, {
      date: '2026-06-06',
      status: 'posted',
      kind: 'recipe',
      refId: recipe.id,
      name: 'Soup',
      units: 6,
    });

    const result = await loadMenuEngineering(db, ORG_A, PERIOD);
    expect(result.classified[0]!.unitsSold).toBe(10);
  });

  it('sets aside a recipe with an unpriced ingredient as needs-pricing (MISSING_COST)', async () => {
    const ing = await createIngredient(db, ORG_A, {
      name: 'Mystery spice',
      dimension: 'weight',
      priceCents: 0,
      needsPricing: true,
    });
    const recipe = await createRecipe(db, ORG_A, {
      name: 'Curry',
      sellingPriceCents: 2000,
    });
    const added = await addRecipeIngredient(db, ORG_A, {
      recipeId: recipe.id,
      ingredientId: ing.id,
      quantity: 500,
    });
    if (!added.ok) throw new Error('failed to add recipe line');
    await insertSale(db, ORG_A, {
      date: '2026-06-07',
      status: 'posted',
      kind: 'recipe',
      refId: recipe.id,
      name: 'Curry',
      units: 3,
    });

    const result = await loadMenuEngineering(db, ORG_A, PERIOD);
    expect(result.classified).toHaveLength(0);
    expect(result.needsPricing).toEqual([
      { kind: 'recipe', id: recipe.id, name: 'Curry', unitsSold: 3, reason: 'MISSING_COST' },
    ]);
  });

  it('sets aside a recipe with no selling price as needs-pricing (MISSING_SELLING_PRICE)', async () => {
    const recipe = await pricedRecipe(db, ORG_A, 'Special', null);
    await insertSale(db, ORG_A, {
      date: '2026-06-08',
      status: 'posted',
      kind: 'recipe',
      refId: recipe.id,
      name: 'Special',
      units: 2,
    });

    const result = await loadMenuEngineering(db, ORG_A, PERIOD);
    expect(result.classified).toHaveLength(0);
    expect(result.needsPricing[0]!.reason).toBe('MISSING_SELLING_PRICE');
  });

  it('classifies a menu from its component recipe cost and posted units', async () => {
    const recipe = await pricedRecipe(db, ORG_A, 'Base', 3000);
    const outcome = await createMenu(
      db,
      ORG_A,
      { name: 'Combo', sellingPriceCents: 3000, notes: null },
      [{ recipeId: recipe.id, quantity: 1 }],
    );
    if (outcome.status !== 'ok') throw new Error('failed to create menu');
    await insertSale(db, ORG_A, {
      date: '2026-06-09',
      status: 'posted',
      kind: 'menu',
      refId: outcome.menu.id,
      name: 'Combo',
      units: 7,
    });

    const result = await loadMenuEngineering(db, ORG_A, PERIOD);
    const menuItem = result.classified.find((c) => c.kind === 'menu');
    expect(menuItem).toBeDefined();
    expect(menuItem!.id).toBe(outcome.menu.id);
    expect(menuItem!.unitsSold).toBe(7);
    expect(menuItem!.costCents).toBe(1000); // one Base portion @ 1000 c
  });

  it('returns an empty result when there are no posted sales', async () => {
    await pricedRecipe(db, ORG_A, 'Unsold', 2000);
    const result = await loadMenuEngineering(db, ORG_A, PERIOD);
    expect(result.classified).toEqual([]);
    expect(result.needsPricing).toEqual([]);
    expect(result.totalUnitsSold).toBe(0);
  });
});
