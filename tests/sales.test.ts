import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  ingredients as ingredientsTable,
  inventoryMovements as movementsTable,
  organizationSettings,
  saleItems as saleItemsTable,
  sales as salesTable,
  transactions as transactionsTable,
} from '@/lib/db/schema';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import {
  createSale,
  postSale,
  voidSale,
  type SaleLineInput,
} from '@/lib/data/sales';
import { DAILY_SALES_CATEGORY_SLUG } from '@/lib/data/transactions';
import { getCategoryIdBySlug } from '@/lib/data/transaction-categories';

const ORG = 'org_a';

/** A weight recipe: one line of `lineQty` g, priced `priceCents`/kg, `stock` g on hand. */
async function makeRecipe(
  db: TenantDb,
  name: string,
  opts: { priceCents: number; lineQty: number; stock: number },
): Promise<{ recipeId: string; ingredientId: string }> {
  const ing = await createIngredient(db, ORG, {
    name: `${name}-ing`,
    dimension: 'weight',
    priceCents: opts.priceCents,
  });
  await db
    .update(ingredientsTable)
    .set({ stockQuantity: String(opts.stock) })
    .where(eq(ingredientsTable.id, ing.id));
  const recipe = await createRecipe(db, ORG, { name });
  const added = await addRecipeIngredient(db, ORG, {
    recipeId: recipe.id,
    ingredientId: ing.id,
    quantity: opts.lineQty,
  });
  if (!added.ok) throw new Error('failed to add recipe line');
  return { recipeId: recipe.id, ingredientId: ing.id };
}

async function setTaxRate(db: TenantDb, bps: number | null): Promise<void> {
  await db
    .insert(organizationSettings)
    .values({ organizationId: ORG, defaultTaxRateBps: bps })
    .onConflictDoUpdate({
      target: organizationSettings.organizationId,
      set: { defaultTaxRateBps: bps },
    });
}

async function setStockControlStart(db: TenantDb, date: string | null): Promise<void> {
  await db
    .insert(organizationSettings)
    .values({ organizationId: ORG, stockControlStartDate: date })
    .onConflictDoUpdate({
      target: organizationSettings.organizationId,
      set: { stockControlStartDate: date },
    });
}

const recipeLine = (recipeId: string, qty: number, unitNetCents: number): SaleLineInput => ({
  itemKind: 'recipe',
  itemRecipeId: recipeId,
  itemMenuId: null,
  itemIngredientId: null,
  quantity: qty,
  ingredientQtyCanonical: null,
  unitNetCents,
  taxRateBps: 2300,
});

async function stockOf(db: TenantDb, ingredientId: string): Promise<number> {
  const [row] = await db
    .select({ q: ingredientsTable.stockQuantity })
    .from(ingredientsTable)
    .where(eq(ingredientsTable.id, ingredientId));
  return Number(row!.q);
}

async function saleMovements(db: TenantDb, saleId: string) {
  return db
    .select()
    .from(movementsTable)
    .where(
      and(
        eq(movementsTable.organizationId, ORG),
        eq(movementsTable.sourceType, 'sale'),
        eq(movementsTable.sourceId, saleId),
      ),
    );
}

async function saleIncomeRows(db: TenantDb, saleId: string) {
  return db
    .select()
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.organizationId, ORG),
        eq(transactionsTable.sourceType, 'sale'),
        eq(transactionsTable.sourceId, saleId),
      ),
    );
}

describe('daily-close sales (Sprint 12a)', () => {
  let client: PGlite;
  let db: TenantDb;
  let recipeId: string; // 100g/portion, 500g stock
  let ingredientId: string;

  beforeEach(async () => {
    const test = await createTestDb();
    client = test.client;
    db = test.db as unknown as TenantDb;
    await setTaxRate(db, 2300);
    const r = await makeRecipe(db, 'Bread', { priceCents: 1000, lineQty: 100, stock: 500 });
    recipeId = r.recipeId;
    ingredientId = r.ingredientId;
  });

  afterEach(async () => {
    await client.close();
  });

  async function draft(lines: SaleLineInput[], saleDate = '2026-07-01') {
    const created = await createSale(db, ORG, { saleDate, note: null }, lines);
    if (created.status !== 'ok') throw new Error(`create failed: ${created.status}`);
    return created.sale;
  }

  it('creates a draft with reconciling line totals and NULL frozen header totals', async () => {
    const sale = await draft([recipeLine(recipeId, 3, 500)]); // 3 × 500c net = 1500c
    expect(sale.status).toBe('draft');
    expect(sale.netCents).toBeNull();
    expect(sale.grossCents).toBeNull();

    const [item] = await db
      .select()
      .from(saleItemsTable)
      .where(eq(saleItemsTable.saleId, sale.id));
    // net = quantity × unit_net; tax independently rounded; gross = net + tax.
    expect(item!.netCents).toBe(1500);
    expect(item!.taxCents).toBe(345);
    expect(item!.grossCents).toBe(1845);
    expect(item!.itemName).toBe('Bread'); // frozen from the source recipe
  });

  it('post writes exactly ONE protected income row (= gross, daily_sales, source=sale) + OUT movement', async () => {
    const sale = await draft([recipeLine(recipeId, 3, 500)]); // net 1500c, tax 23% = 345c, gross 1845c

    const outcome = await runInOrg(db, ORG, (tx) =>
      postSale(tx, ORG, sale.id, sale.updatedAt),
    );
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.stockMoved).toBe(true);
    expect(outcome.movementCount).toBe(1);

    const [posted] = await db.select().from(salesTable).where(eq(salesTable.id, sale.id));
    expect(posted!.status).toBe('posted');
    expect(posted!.netCents).toBe(1500);
    expect(posted!.taxCents).toBe(345);
    expect(posted!.grossCents).toBe(1845);

    const income = await saleIncomeRows(db, sale.id);
    expect(income).toHaveLength(1);
    expect(income[0]!.type).toBe('income');
    expect(income[0]!.amountCents).toBe(1845);
    const dailyCat = await getCategoryIdBySlug(db, ORG, DAILY_SALES_CATEGORY_SLUG);
    expect(income[0]!.categoryId).toBe(dailyCat);

    // 100g/portion × 3 = 300g consumed → stock 500 → 200.
    const moves = await saleMovements(db, sale.id);
    expect(moves).toHaveLength(1);
    expect(Number(moves[0]!.deltaCanonical)).toBe(-300);
    expect(await stockOf(db, ingredientId)).toBe(200);
  });

  it('re-posting the same sale is an idempotent no-op (no second income row / movement)', async () => {
    const sale = await draft([recipeLine(recipeId, 2, 500)]);
    const first = await runInOrg(db, ORG, (tx) => postSale(tx, ORG, sale.id, sale.updatedAt));
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;

    const again = await runInOrg(db, ORG, (tx) =>
      postSale(tx, ORG, sale.id, first.sale.updatedAt),
    );
    expect(again.status).toBe('ok');
    if (again.status !== 'ok') return;
    expect(again.alreadyPosted).toBe(true);

    expect(await saleIncomeRows(db, sale.id)).toHaveLength(1);
    expect(await saleMovements(db, sale.id)).toHaveLength(1);
  });

  it('refuses to post without a configured org tax rate', async () => {
    await setTaxRate(db, null);
    const sale = await draft([recipeLine(recipeId, 1, 500)]);
    const outcome = await runInOrg(db, ORG, (tx) => postSale(tx, ORG, sale.id, sale.updatedAt));
    expect(outcome.status).toBe('tax_rate_required');
    expect(await saleIncomeRows(db, sale.id)).toHaveLength(0);
  });

  it('financial-only mode: post before the stock-control start books revenue but moves NO stock', async () => {
    await setStockControlStart(db, '2026-08-01'); // sale date 2026-07-01 is before
    const sale = await draft([recipeLine(recipeId, 3, 500)], '2026-07-01');
    const outcome = await runInOrg(db, ORG, (tx) => postSale(tx, ORG, sale.id, sale.updatedAt));
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.stockMoved).toBe(false);
    expect(outcome.movementCount).toBe(0);

    expect(await saleIncomeRows(db, sale.id)).toHaveLength(1); // revenue still booked
    expect(await saleMovements(db, sale.id)).toHaveLength(0);
    expect(await stockOf(db, ingredientId)).toBe(500); // untouched
  });

  it('an oversized stock-out rolls back the WHOLE post (no income row, no partial movement)', async () => {
    // 10 portions × 100g = 1000g needed, only 500g on hand.
    const sale = await draft([recipeLine(recipeId, 10, 500)]);
    await expect(
      runInOrg(db, ORG, (tx) => postSale(tx, ORG, sale.id, sale.updatedAt)),
    ).rejects.toThrow();

    const [row] = await db.select().from(salesTable).where(eq(salesTable.id, sale.id));
    expect(row!.status).toBe('draft');
    expect(await saleIncomeRows(db, sale.id)).toHaveLength(0);
    expect(await saleMovements(db, sale.id)).toHaveLength(0);
    expect(await stockOf(db, ingredientId)).toBe(500);
  });

  it('void soft-deletes the income row + reverses stock; a second void is a no-op', async () => {
    const sale = await draft([recipeLine(recipeId, 3, 500)]);
    const posted = await runInOrg(db, ORG, (tx) => postSale(tx, ORG, sale.id, sale.updatedAt));
    if (posted.status !== 'ok') throw new Error('post failed');
    expect(await stockOf(db, ingredientId)).toBe(200);

    const voided = await runInOrg(db, ORG, (tx) =>
      voidSale(tx, ORG, sale.id, posted.sale.updatedAt),
    );
    expect(voided.status).toBe('ok');
    if (voided.status !== 'ok') return;
    expect(voided.reversalCount).toBe(1);

    const [row] = await db.select().from(salesTable).where(eq(salesTable.id, sale.id));
    expect(row!.status).toBe('void');
    // The income row is soft-deleted (retained, deleted_at set).
    const income = await saleIncomeRows(db, sale.id);
    expect(income).toHaveLength(1);
    expect(income[0]!.deletedAt).not.toBeNull();
    // Stock added back by the reversal.
    expect(await stockOf(db, ingredientId)).toBe(500);

    // A second void is an idempotent no-op (no second reversal).
    const again = await runInOrg(db, ORG, (tx) =>
      voidSale(tx, ORG, sale.id, row!.updatedAt),
    );
    expect(again.status).toBe('ok');
    if (again.status !== 'ok') return;
    expect(again.alreadyVoided).toBe(true);
    // Ledger keeps the 1 OUT ('sale') + 1 reversal ('reversal') — no THIRD row from the
    // second void, and stock is unchanged at 500.
    const allForSale = await db
      .select()
      .from(movementsTable)
      .where(and(eq(movementsTable.organizationId, ORG), eq(movementsTable.sourceId, sale.id)));
    expect(allForSale).toHaveLength(2);
    expect(await stockOf(db, ingredientId)).toBe(500);
  });

  it('rejects a second non-void close on the same date (partial unique)', async () => {
    await draft([recipeLine(recipeId, 1, 500)], '2026-07-02');
    const second = await createSale(
      db,
      ORG,
      { saleDate: '2026-07-02', note: null },
      [recipeLine(recipeId, 1, 500)],
    );
    expect(second.status).toBe('date_taken');
  });
});
