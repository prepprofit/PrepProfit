import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { saleItems, sales } from '@/lib/db/schema';
import type { SaleItemKind, SaleStatus } from '@/lib/db/schema';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import { loadDailyCloseInsights } from '@/lib/data/daily-close-insights';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

/**
 * Insert a close + its lines directly (bypassing the full post flow — we control the
 * frozen totals + dates the loader reads). Posted/void carry frozen money + posted_at to
 * satisfy the schema CHECKs; a void also carries voided_at. Returns the sale id.
 */
async function insertClose(
  db: TenantDb,
  org: string,
  opts: {
    date: string;
    status: SaleStatus;
    netCents: number;
    taxCents: number;
    grossCents: number;
    lines?: {
      kind: SaleItemKind;
      refId: string;
      name: string;
      units: number;
      netCents: number;
    }[];
  },
): Promise<string> {
  const terminal = opts.status !== 'draft';
  const [sale] = await db
    .insert(sales)
    .values({
      organizationId: org,
      saleDate: opts.date,
      status: opts.status,
      netCents: terminal ? opts.netCents : null,
      taxCents: terminal ? opts.taxCents : null,
      grossCents: terminal ? opts.grossCents : null,
      postedAt: terminal ? new Date() : null,
      voidedAt: opts.status === 'void' ? new Date() : null,
    })
    .returning();
  if (!sale) throw new Error('failed to insert sale');
  if (opts.lines?.length) {
    await db.insert(saleItems).values(
      opts.lines.map((l, index) => ({
        organizationId: org,
        saleId: sale.id,
        itemKind: l.kind,
        itemRecipeId: l.kind === 'recipe' ? l.refId : null,
        itemMenuId: l.kind === 'menu' ? l.refId : null,
        itemIngredientId: l.kind === 'ingredient' ? l.refId : null,
        itemName: l.name,
        quantity: l.units,
        ingredientQtyCanonical: null,
        unitNetCents: Math.round(l.netCents / l.units),
        taxRateBps: 0,
        netCents: l.netCents,
        taxCents: 0,
        grossCents: l.netCents,
        sortOrder: index,
      })),
    );
  }
  return sale.id;
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

describe('loadDailyCloseInsights', () => {
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

  it('summarizes a posted close: food cost from current recipe cost, over net', async () => {
    const recipe = await pricedRecipe(db, ORG_A, 'Steak', 3000);
    const saleId = await insertClose(db, ORG_A, {
      date: '2026-06-15',
      status: 'posted',
      netCents: 3000,
      taxCents: 300,
      grossCents: 3300,
      lines: [{ kind: 'recipe', refId: recipe.id, name: 'Steak', units: 3, netCents: 3000 }],
    });

    const result = await loadDailyCloseInsights(db, ORG_A, saleId);
    expect(result).not.toBeNull();
    // 3 portions × 1000 c/portion = 3000 c food cost; 3000 / 3000 net = 100%.
    expect(result!.estimatedFoodCostCents).toBe(3000);
    expect(result!.foodCostPercent).toBe(100);
    expect(result!.costComplete).toBe(true);
    expect(result!.unitsSold).toBe(3);
    expect(result!.topSellers[0]!.id).toBe(recipe.id);
  });

  it('returns null for a draft or a void close (never a misleading summary)', async () => {
    const recipe = await pricedRecipe(db, ORG_A, 'Soup', 2000);
    const draft = await insertClose(db, ORG_A, {
      date: '2026-06-16',
      status: 'draft',
      netCents: 0,
      taxCents: 0,
      grossCents: 0,
      lines: [{ kind: 'recipe', refId: recipe.id, name: 'Soup', units: 2, netCents: 2000 }],
    });
    const voided = await insertClose(db, ORG_A, {
      date: '2026-06-17',
      status: 'void',
      netCents: 2000,
      taxCents: 0,
      grossCents: 2000,
      lines: [{ kind: 'recipe', refId: recipe.id, name: 'Soup', units: 2, netCents: 2000 }],
    });

    expect(await loadDailyCloseInsights(db, ORG_A, draft)).toBeNull();
    expect(await loadDailyCloseInsights(db, ORG_A, voided)).toBeNull();
  });

  it('sets aside a line whose ingredient needs pricing (never a fabricated cost)', async () => {
    const ing = await createIngredient(db, ORG_A, {
      name: 'Mystery spice',
      dimension: 'weight',
      priceCents: 0,
      needsPricing: true,
    });
    const recipe = await createRecipe(db, ORG_A, { name: 'Curry', sellingPriceCents: 2000 });
    const added = await addRecipeIngredient(db, ORG_A, {
      recipeId: recipe.id,
      ingredientId: ing.id,
      quantity: 500,
    });
    if (!added.ok) throw new Error('failed to add recipe line');
    const saleId = await insertClose(db, ORG_A, {
      date: '2026-06-18',
      status: 'posted',
      netCents: 2000,
      taxCents: 0,
      grossCents: 2000,
      lines: [{ kind: 'recipe', refId: recipe.id, name: 'Curry', units: 1, netCents: 2000 }],
    });

    const result = await loadDailyCloseInsights(db, ORG_A, saleId);
    expect(result!.estimatedFoodCostCents).toBeNull();
    expect(result!.costComplete).toBe(false);
    expect(result!.missingCostItems).toEqual([
      { kind: 'recipe', id: recipe.id, name: 'Curry', unitsSold: 1 },
    ]);
  });

  it('reports variance vs same-weekday prior posted closes, scoped to the org', async () => {
    const recipe = await pricedRecipe(db, ORG_A, 'Special', 1000);
    // Same weekday (7-day steps): three prior closes at 1000 c, today doubles to 2000 c.
    for (const date of ['2026-06-06', '2026-06-13', '2026-06-20']) {
      await insertClose(db, ORG_A, {
        date,
        status: 'posted',
        netCents: 1000,
        taxCents: 0,
        grossCents: 1000,
        lines: [{ kind: 'recipe', refId: recipe.id, name: 'Special', units: 1, netCents: 1000 }],
      });
    }
    // Another org's busy Saturdays must never feed this org's baseline.
    const otherRecipe = await pricedRecipe(db, ORG_B, 'Special B', 1000);
    await insertClose(db, ORG_B, {
      date: '2026-06-20',
      status: 'posted',
      netCents: 99999,
      taxCents: 0,
      grossCents: 99999,
      lines: [{ kind: 'recipe', refId: otherRecipe.id, name: 'Special B', units: 1, netCents: 99999 }],
    });

    const todayId = await insertClose(db, ORG_A, {
      date: '2026-06-27',
      status: 'posted',
      netCents: 2000,
      taxCents: 0,
      grossCents: 2000,
      lines: [{ kind: 'recipe', refId: recipe.id, name: 'Special', units: 2, netCents: 2000 }],
    });

    const result = await loadDailyCloseInsights(db, ORG_A, todayId);
    expect(result!.variance).toEqual({
      baselineAvgGrossCents: 1000,
      sampleSize: 3,
      changePercent: 100,
      direction: 'up',
      unusual: true,
    });
  });

  it('withholds variance when there is no comparable history', async () => {
    const recipe = await pricedRecipe(db, ORG_A, 'Lonely', 1000);
    const saleId = await insertClose(db, ORG_A, {
      date: '2026-06-27',
      status: 'posted',
      netCents: 2000,
      taxCents: 0,
      grossCents: 2000,
      lines: [{ kind: 'recipe', refId: recipe.id, name: 'Lonely', units: 2, netCents: 2000 }],
    });
    const result = await loadDailyCloseInsights(db, ORG_A, saleId);
    expect(result!.variance).toBeNull();
  });

  it('does not load another org’s close', async () => {
    const recipe = await pricedRecipe(db, ORG_B, 'Theirs', 1000);
    const saleId = await insertClose(db, ORG_B, {
      date: '2026-06-15',
      status: 'posted',
      netCents: 1000,
      taxCents: 0,
      grossCents: 1000,
      lines: [{ kind: 'recipe', refId: recipe.id, name: 'Theirs', units: 1, netCents: 1000 }],
    });
    expect(await loadDailyCloseInsights(db, ORG_A, saleId)).toBeNull();
  });
});
