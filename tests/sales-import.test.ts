import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  auditLog,
  ingredients as ingredientsTable,
  inventoryMovements as movementsTable,
  organizationSettings,
  recipes as recipesTable,
  sales as salesTable,
  transactions as transactionsTable,
} from '@/lib/db/schema';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import { planSalesImport, applySalesImport } from '@/lib/data/sales-import';
import { parseSalesRows, type DraftSaleImportRow } from '@/lib/import/parse';
import type { ParsedRow } from '@/lib/import/parse';
import { importSalesPayloadSchema } from '@/lib/validation/import';
import { DAILY_SALES_CATEGORY_SLUG } from '@/lib/data/transactions';
import { getCategoryIdBySlug } from '@/lib/data/transaction-categories';
import type { AuditActor } from '@/lib/data/audit';

const ORG = 'org_a';
const ACTOR: AuditActor = { userId: 'user_a', role: 'manager', requestId: 'req_1' };

const HEADER =
  'date,item_kind,item_name,quantity,unit_net_price,tax_rate_percent,ingredient_qty_canonical';

let client: PGlite;
let db: TenantDb;

beforeEach(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  await setTaxRate(2300);
});

afterEach(async () => {
  await client.close();
});

async function setTaxRate(bps: number | null): Promise<void> {
  await db
    .insert(organizationSettings)
    .values({ organizationId: ORG, defaultTaxRateBps: bps })
    .onConflictDoUpdate({
      target: organizationSettings.organizationId,
      set: { defaultTaxRateBps: bps },
    });
}

async function setStockControlStart(date: string | null): Promise<void> {
  await db
    .insert(organizationSettings)
    .values({ organizationId: ORG, stockControlStartDate: date })
    .onConflictDoUpdate({
      target: organizationSettings.organizationId,
      set: { stockControlStartDate: date },
    });
}

/** A weight recipe of `lineQty` g/portion (yield 1 portion), with `stock` g on hand. */
async function makeRecipe(
  name: string,
  opts: { lineQty: number; stock: number },
): Promise<string> {
  const ing = await createIngredient(db, ORG, { name: `${name}-ing`, dimension: 'weight', priceCents: 1000 });
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
  return recipe.id;
}

async function makeIngredient(name: string, stock: number): Promise<string> {
  const ing = await createIngredient(db, ORG, { name, dimension: 'weight', priceCents: 500 });
  await db
    .update(ingredientsTable)
    .set({ stockQuantity: String(stock) })
    .where(eq(ingredientsTable.id, ing.id));
  return ing.id;
}

function parse(csv: string): ParsedRow<DraftSaleImportRow>[] {
  const result = parseSalesRows(csv.split('\n').map((l) => l.split(',')));
  if (!result.ok) throw new Error(`parse failed: ${result.error}`);
  return result.rows;
}

async function plan(csv: string, stockStart: string | null = null) {
  const settings = { defaultTaxRateBps: 2300, stockControlStartDate: stockStart };
  return runInOrg(db, ORG, (tx) => planSalesImport(tx, ORG, parse(csv), settings));
}

/* -------------------------------------------------------------------------- */
/* Resolver / planner                                                         */
/* -------------------------------------------------------------------------- */

describe('planSalesImport — resolution + grouping', () => {
  it('links an exact single active match and marks the close importable', async () => {
    await makeRecipe('Bread', { lineQty: 100, stock: 500 });
    const result = await plan(`${HEADER}\n2026-06-01,recipe,Bread,3,5.00,,`);
    expect(result.counts).toMatchObject({ total: 1, importable: 1, skipped: 0, invalid: 0 });
    const line = result.payload.closes[0]!.lines[0]!;
    expect(line.itemRecipeId).not.toBeNull();
    expect(line.netCents).toBe(1500);
    expect(line.taxCents).toBe(345);
  });

  it('flags UNKNOWN_ITEM when no active item matches', async () => {
    const result = await plan(`${HEADER}\n2026-06-01,recipe,Ghost,1,5.00,,`);
    expect(result.counts.invalid).toBe(1);
    expect(result.payload.closes[0]!.status).toBe('invalid');
    expect(result.issues.map((i) => i.code)).toContain('UNKNOWN_ITEM');
  });

  it('flags AMBIGUOUS_ITEM when two active items share the name', async () => {
    await makeRecipe('Special', { lineQty: 50, stock: 500 });
    await makeRecipe('Special', { lineQty: 50, stock: 500 });
    const result = await plan(`${HEADER}\n2026-06-01,recipe,Special,1,5.00,,`);
    expect(result.counts.invalid).toBe(1);
    expect(result.issues.map((i) => i.code)).toContain('AMBIGUOUS_ITEM');
  });

  it('ignores trashed items (a trashed recipe is UNKNOWN_ITEM)', async () => {
    const id = await makeRecipe('Cake', { lineQty: 100, stock: 500 });
    await db.update(recipesTable).set({ deletedAt: new Date() }).where(eq(recipesTable.id, id));
    const result = await plan(`${HEADER}\n2026-06-01,recipe,Cake,1,5.00,,`);
    expect(result.issues.map((i) => i.code)).toContain('UNKNOWN_ITEM');
  });

  it('scopes lookup by item_kind (same name across kinds is fine)', async () => {
    await makeRecipe('Combo', { lineQty: 100, stock: 500 });
    await makeIngredient('Combo', 1000);
    const result = await plan(
      `${HEADER}\n2026-06-01,recipe,Combo,1,5.00,,\n2026-06-01,ingredient,Combo,1,2.00,,200`,
    );
    expect(result.counts.importable).toBe(1);
    const [a, b] = result.payload.closes[0]!.lines;
    expect(a!.itemRecipeId).not.toBeNull();
    expect(b!.itemIngredientId).not.toBeNull();
  });

  it('skips a date that already has a non-void sale, imports one with only a void sale', async () => {
    await makeRecipe('Bun', { lineQty: 100, stock: 500 });
    // A draft (non-void) sale on 2026-06-01, a fully-voided sale on 2026-06-02.
    await db.insert(salesTable).values([
      { organizationId: ORG, saleDate: '2026-06-01', status: 'draft' },
      {
        organizationId: ORG,
        saleDate: '2026-06-02',
        status: 'void',
        netCents: 0,
        taxCents: 0,
        grossCents: 0,
        postedAt: new Date(),
        voidedAt: new Date(),
        stockMoved: false,
      },
    ]);
    const result = await plan(
      `${HEADER}\n2026-06-01,recipe,Bun,1,5.00,,\n2026-06-02,recipe,Bun,1,5.00,,`,
    );
    expect(result.counts).toMatchObject({ total: 2, importable: 1, skipped: 1 });
    const byDate = new Map(result.payload.closes.map((c) => [c.saleDate, c]));
    expect(byDate.get('2026-06-01')!.status).toBe('skipped');
    expect(byDate.get('2026-06-02')!.status).toBe('importable');
    expect(result.issues.map((i) => i.code)).toContain('DUPLICATE');
  });

  it('counts reconcile by CLOSE, not by raw row', async () => {
    await makeRecipe('A', { lineQty: 100, stock: 5000 });
    const result = await plan(
      `${HEADER}\n2026-06-01,recipe,A,1,5.00,,\n2026-06-01,recipe,A,2,5.00,,\n2026-06-02,recipe,A,1,5.00,,`,
    );
    expect(result.counts.total).toBe(2);
    expect(result.counts.importable).toBe(2);
  });

  it('marks every importable close financial-only before the stock-control start date', async () => {
    await makeRecipe('Loaf', { lineQty: 100, stock: 500 });
    const result = await plan(`${HEADER}\n2026-05-01,recipe,Loaf,1,5.00,,`, '2026-06-01');
    expect(result.financialOnly).toBe(1);
    expect(result.payload.closes[0]!.stockMode).toBe('financial_only');
  });
});

/* -------------------------------------------------------------------------- */
/* Apply / confirm (through the 12a primitives)                               */
/* -------------------------------------------------------------------------- */

describe('applySalesImport — posting through 12a', () => {
  it('posts multiple closes: one protected income row each + frozen totals + OUT movement', async () => {
    const recipeId = await makeRecipe('Bread', { lineQty: 100, stock: 1000 });
    const result = await plan(
      `${HEADER}\n2026-06-01,recipe,Bread,3,5.00,,\n2026-06-02,recipe,Bread,2,5.00,,`,
    );
    const applied = await runInOrg(db, ORG, (tx) =>
      applySalesImport(tx, ORG, ACTOR, result.payload.closes),
    );
    expect(applied).toMatchObject({ closesCreated: 2, linesCreated: 2, financialOnly: 0 });

    const posted = await db
      .select()
      .from(salesTable)
      .where(eq(salesTable.organizationId, ORG));
    expect(posted).toHaveLength(2);
    expect(posted.every((s) => s.status === 'posted')).toBe(true);

    const income = await db
      .select()
      .from(transactionsTable)
      .where(
        and(eq(transactionsTable.organizationId, ORG), eq(transactionsTable.sourceType, 'sale')),
      );
    expect(income).toHaveLength(2);
    const dailyCat = await getCategoryIdBySlug(db, ORG, DAILY_SALES_CATEGORY_SLUG);
    expect(income.every((t) => t.type === 'income' && t.categoryId === dailyCat)).toBe(true);

    // One aggregated OUT movement per close (each close has one recipe line).
    void recipeId;
    const moves = await db
      .select()
      .from(movementsTable)
      .where(and(eq(movementsTable.organizationId, ORG), eq(movementsTable.sourceType, 'sale')));
    expect(moves).toHaveLength(2);
  });

  it('a pre-start-date close is financial-only: revenue posts, no movement', async () => {
    await makeRecipe('Bread', { lineQty: 100, stock: 300 });
    // postSale re-reads the org's stock-control start date — persist it, not just the plan arg.
    await setStockControlStart('2026-06-01');
    const result = await plan(`${HEADER}\n2026-05-01,recipe,Bread,5,5.00,,`, '2026-06-01');
    const applied = await runInOrg(db, ORG, (tx) =>
      applySalesImport(tx, ORG, ACTOR, result.payload.closes),
    );
    expect(applied).toMatchObject({ closesCreated: 1, movementsCreated: 0, financialOnly: 1 });

    const [sale] = await db.select().from(salesTable).where(eq(salesTable.organizationId, ORG));
    expect(sale!.stockMoved).toBe(false);
    const income = await db
      .select()
      .from(transactionsTable)
      .where(and(eq(transactionsTable.organizationId, ORG), eq(transactionsTable.sourceType, 'sale')));
    expect(income).toHaveLength(1);
    const moves = await db
      .select()
      .from(movementsTable)
      .where(eq(movementsTable.organizationId, ORG));
    expect(moves).toHaveLength(0);
  });

  it('is all-or-nothing: a second close that oversells rolls back the whole confirm', async () => {
    await makeRecipe('Bread', { lineQty: 100, stock: 250 }); // only 250g on hand
    const result = await plan(
      // close 1 needs 100g (ok), close 2 needs 300g (oversell) → whole thing must fail.
      `${HEADER}\n2026-06-01,recipe,Bread,1,5.00,,\n2026-06-02,recipe,Bread,3,5.00,,`,
    );
    await expect(
      runInOrg(db, ORG, (tx) => applySalesImport(tx, ORG, ACTOR, result.payload.closes)),
    ).rejects.toThrow();

    // Nothing committed: no sales, no income, no movements, no audit.
    expect(await db.select().from(salesTable).where(eq(salesTable.organizationId, ORG))).toHaveLength(0);
    expect(
      await db.select().from(transactionsTable).where(eq(transactionsTable.organizationId, ORG)),
    ).toHaveLength(0);
    expect(await db.select().from(movementsTable).where(eq(movementsTable.organizationId, ORG))).toHaveLength(0);
    expect(await db.select().from(auditLog).where(eq(auditLog.organizationId, ORG))).toHaveLength(0);
  });

  it('throws SALE_DATE_TAKEN when a manual close took the date after preview', async () => {
    await makeRecipe('Bread', { lineQty: 100, stock: 500 });
    const result = await plan(`${HEADER}\n2026-06-01,recipe,Bread,1,5.00,,`);
    // A manual non-void (draft) close lands on the same date between preview and confirm.
    await db.insert(salesTable).values({ organizationId: ORG, saleDate: '2026-06-01', status: 'draft' });

    await expect(
      runInOrg(db, ORG, (tx) => applySalesImport(tx, ORG, ACTOR, result.payload.closes)),
    ).rejects.toMatchObject({ code: 'SALE_DATE_TAKEN' });
    expect(
      result.payload.closes[0]!.status,
    ).toBe('importable'); // it WAS importable at plan time
  });

  it('writes per-sale create + post audit events (counts only, no amounts)', async () => {
    await makeRecipe('Bread', { lineQty: 100, stock: 1000 });
    const result = await plan(`${HEADER}\n2026-06-01,recipe,Bread,3,5.00,,`);
    await runInOrg(db, ORG, (tx) => applySalesImport(tx, ORG, ACTOR, result.payload.closes));

    const events = await db.select().from(auditLog).where(eq(auditLog.organizationId, ORG));
    const actions = events.map((e) => e.action);
    expect(actions).toContain('sale.create');
    expect(actions).toContain('sale.post');
    // No amount fields leak into metadata.
    for (const e of events) {
      const meta = (e.metadata ?? {}) as Record<string, unknown>;
      expect(meta).not.toHaveProperty('grossCents');
      expect(meta).not.toHaveProperty('netCents');
      expect(meta).not.toHaveProperty('itemName');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Confirm-time payload defense                                               */
/* -------------------------------------------------------------------------- */

describe('importSalesPayloadSchema — confirm-time defense', () => {
  it('accepts a well-formed plan payload', async () => {
    await makeRecipe('Bread', { lineQty: 100, stock: 500 });
    const result = await plan(`${HEADER}\n2026-06-01,recipe,Bread,1,5.00,,`);
    expect(importSalesPayloadSchema.safeParse(result.payload).success).toBe(true);
  });

  it('rejects an importable close whose line lost its resolved id (tamper)', async () => {
    await makeRecipe('Bread', { lineQty: 100, stock: 500 });
    const result = await plan(`${HEADER}\n2026-06-01,recipe,Bread,1,5.00,,`);
    // Tamper: drop the resolved recipe id on an importable line.
    result.payload.closes[0]!.lines[0]!.itemRecipeId = null;
    expect(importSalesPayloadSchema.safeParse(result.payload).success).toBe(false);
  });
});
