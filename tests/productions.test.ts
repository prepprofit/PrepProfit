import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  ingredients as ingredientsTable,
  productionItems as productionItemsTable,
  productions as productionsTable,
  recipes as recipesTable,
  inventoryMovements as movementsTable,
  transactionCategories as categoriesTable,
  transactions as transactionsTable,
} from '@/lib/db/schema';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe, softDeleteRecipe, restoreRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import {
  countProductionsUsingRecipe,
  createProduction,
  getKitchenProduction,
  getManagerProduction,
  listKitchenProductions,
  listManagerProductions,
  listTrashedProductions,
  planProduction,
  purgeProduction,
  reopenProduction,
  restoreProduction,
  softDeleteProduction,
  updateDraftProduction,
} from '@/lib/data/productions';
import { purgeRecipeWithGuards } from '@/lib/data/recipe-purge';
import { purgeExpired } from '@/lib/data/trash';
import { buildOrgDataExport } from '@/lib/data/account-export';
import { purgeCutoff, TRASH_RETENTION_DAYS } from '@/lib/trash';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY_MS);

/**
 * A weight recipe: one ingredient line of `lineQty` grams, priced `priceCents`/kg,
 * with `stock` grams on hand. yield 1 portion / 100% so explosion = lineQty × portions.
 */
async function makeRecipe(
  db: TenantDb,
  org: string,
  name: string,
  opts: { priceCents: number; lineQty: number; stock: number },
): Promise<{ recipeId: string; ingredientId: string }> {
  const ing = await createIngredient(db, org, {
    name: `${name}-ing`,
    dimension: 'weight',
    priceCents: opts.priceCents,
  });
  await db
    .update(ingredientsTable)
    .set({ stockQuantity: String(opts.stock) })
    .where(eq(ingredientsTable.id, ing.id));
  const recipe = await createRecipe(db, org, { name });
  const added = await addRecipeIngredient(db, org, {
    recipeId: recipe.id,
    ingredientId: ing.id,
    quantity: opts.lineQty,
  });
  if (!added.ok) throw new Error('failed to add line');
  return { recipeId: recipe.id, ingredientId: ing.id };
}

describe('productions data layer', () => {
  let client: PGlite;
  let db: TenantDb;
  let aId: string; // recipe A: 100g/portion @ 1000c/kg, 500g stock
  let aIng: string;
  let bId: string; // recipe B: 50g/portion @ 2000c/kg, 1000g stock
  let bIng: string;

  beforeEach(async () => {
    const test = await createTestDb();
    client = test.client;
    db = test.db;
    const a = await makeRecipe(db, ORG_A, 'Bread', {
      priceCents: 1000,
      lineQty: 100,
      stock: 500,
    });
    const b = await makeRecipe(db, ORG_A, 'Cake', {
      priceCents: 2000,
      lineQty: 50,
      stock: 1000,
    });
    aId = a.recipeId;
    aIng = a.ingredientId;
    bId = b.recipeId;
    bIng = b.ingredientId;
  });

  afterEach(async () => {
    await client.close();
  });

  it('creates a draft and explodes requirements + shortfall on read', async () => {
    const created = await createProduction(
      db,
      ORG_A,
      { reference: 'Sat prep', notes: null, plannedFor: '2026-07-01' },
      [
        { recipeId: aId, plannedQty: 10 }, // 100g × 10 = 1000g, stock 500 → short 500
        { recipeId: bId, plannedQty: 4 }, // 50g × 4 = 200g, stock 1000 → 0
      ],
    );
    expect(created.status).toBe('ok');
    if (created.status !== 'ok') return;
    expect(created.production.status).toBe('draft');

    const detail = await getKitchenProduction(db, ORG_A, created.production.id);
    expect(detail?.explosion.complete).toBe(true);
    const reqs = detail?.explosion.requirements ?? [];
    const byIng = Object.fromEntries(reqs.map((r) => [r.ingredientId, r]));
    expect(byIng[aIng]?.neededCanonical).toBe(1000);
    expect(byIng[aIng]?.shortfallCanonical).toBe(500);
    expect(byIng[bIng]?.neededCanonical).toBe(200);
    expect(byIng[bIng]?.shortfallCanonical).toBe(0);
  });

  it('F4: kitchen DTO has no money key; manager DTO carries cost', async () => {
    const created = await createProduction(
      db,
      ORG_A,
      { reference: null, notes: null, plannedFor: null },
      [{ recipeId: aId, plannedQty: 2 }],
    );
    if (created.status !== 'ok') throw new Error('create failed');

    const kitchen = await getKitchenProduction(db, ORG_A, created.production.id);
    const serialized = JSON.stringify(kitchen);
    expect(serialized).not.toMatch(/cost/i);
    expect(serialized).not.toMatch(/price/i);

    const manager = await getManagerProduction(db, ORG_A, created.production.id);
    // 100g @ 1000c/kg = 100c per portion × 2 = 200c.
    expect(manager?.cost.costCents).toBe(200);
    expect(manager?.lines[0]?.lineCostCents).toBe(200);
  });

  it('price change moves manager cost but NOT the explosion; stock moves only shortfall', async () => {
    const created = await createProduction(
      db,
      ORG_A,
      { reference: null, notes: null, plannedFor: null },
      [{ recipeId: aId, plannedQty: 10 }],
    );
    if (created.status !== 'ok') throw new Error('create failed');
    const id = created.production.id;

    const before = await getManagerProduction(db, ORG_A, id);
    expect(before?.cost.costCents).toBe(1000); // 100g×10 = 1000g → 1000c @ 1000c/kg
    expect(before?.explosion.requirements[0]?.neededCanonical).toBe(1000);

    // Double the price → cost doubles, requirement unchanged.
    await db
      .update(ingredientsTable)
      .set({ priceCents: 2000 })
      .where(eq(ingredientsTable.id, aIng));
    const afterPrice = await getManagerProduction(db, ORG_A, id);
    expect(afterPrice?.cost.costCents).toBe(2000);
    expect(afterPrice?.explosion.requirements[0]?.neededCanonical).toBe(1000);

    // Raise stock → shortfall drops, requirement + cost formula unchanged.
    await db
      .update(ingredientsTable)
      .set({ stockQuantity: '900' })
      .where(eq(ingredientsTable.id, aIng));
    const afterStock = await getManagerProduction(db, ORG_A, id);
    expect(afterStock?.explosion.requirements[0]?.shortfallCanonical).toBe(100);
    expect(afterStock?.explosion.requirements[0]?.neededCanonical).toBe(1000);
  });

  it('plan requires a date AND a complete explosion; planned is read-only until reopen', async () => {
    const created = await createProduction(
      db,
      ORG_A,
      { reference: null, notes: null, plannedFor: null },
      [{ recipeId: aId, plannedQty: 1 }],
    );
    if (created.status !== 'ok') throw new Error('create failed');
    const id = created.production.id;

    // No planned date → incomplete.
    const noDate = await planProduction(db, ORG_A, id, created.production.updatedAt);
    expect(noDate.status).toBe('incomplete');

    // Set a date via update, then plan succeeds.
    const dated = await updateDraftProduction(
      db,
      ORG_A,
      id,
      created.production.updatedAt,
      { reference: null, notes: null, plannedFor: '2026-07-01' },
      [{ recipeId: aId, plannedQty: 1 }],
    );
    if (dated.status !== 'ok') throw new Error('update failed');
    const planned = await planProduction(db, ORG_A, id, dated.production.updatedAt);
    expect(planned.status).toBe('ok');
    if (planned.status !== 'ok') return;
    expect(planned.production.status).toBe('planned');

    // A planned production refuses edits (not_editable) until reopened.
    const edit = await updateDraftProduction(
      db,
      ORG_A,
      id,
      planned.production.updatedAt,
      { reference: 'x', notes: null, plannedFor: '2026-07-01' },
      [{ recipeId: aId, plannedQty: 2 }],
    );
    expect(edit.status).toBe('not_editable');

    const reopened = await reopenProduction(
      db,
      ORG_A,
      id,
      planned.production.updatedAt,
    );
    expect(reopened.status).toBe('ok');
    if (reopened.status !== 'ok') return;
    expect(reopened.production.status).toBe('draft');
  });

  it('optimistic concurrency: a stale updatedAt rejects with no write', async () => {
    const created = await createProduction(
      db,
      ORG_A,
      { reference: 'orig', notes: null, plannedFor: null },
      [{ recipeId: aId, plannedQty: 1 }],
    );
    if (created.status !== 'ok') throw new Error('create failed');

    const stale = await updateDraftProduction(
      db,
      ORG_A,
      created.production.id,
      new Date(0), // deliberately wrong version
      { reference: 'hacked', notes: null, plannedFor: null },
      [{ recipeId: aId, plannedQty: 9 }],
    );
    expect(stale.status).toBe('stale');

    const [row] = await db
      .select()
      .from(productionsTable)
      .where(eq(productionsTable.id, created.production.id));
    expect(row?.reference).toBe('orig');
  });

  it('rejects duplicate, missing, trashed and cross-org recipes', async () => {
    // Trashed recipe.
    await softDeleteRecipe(db, ORG_A, bId);
    const trashed = await createProduction(
      db,
      ORG_A,
      { reference: null, notes: null, plannedFor: null },
      [{ recipeId: bId, plannedQty: 1 }],
    );
    expect(trashed.status).toBe('recipe_invalid');
    await restoreRecipe(db, ORG_A, bId);

    // Missing id.
    const missing = await createProduction(
      db,
      ORG_A,
      { reference: null, notes: null, plannedFor: null },
      [{ recipeId: 'nope', plannedQty: 1 }],
    );
    expect(missing.status).toBe('recipe_invalid');

    // Cross-org recipe id (B's recipe used under ORG_B context would not resolve).
    const cross = await createProduction(
      db,
      ORG_B,
      { reference: null, notes: null, plannedFor: null },
      [{ recipeId: aId, plannedQty: 1 }],
    );
    expect(cross.status).toBe('recipe_invalid');
  });

  it('a trashed component makes the plan incomplete; restore recovers it', async () => {
    const created = await createProduction(
      db,
      ORG_A,
      { reference: null, notes: null, plannedFor: '2026-07-01' },
      [{ recipeId: aId, plannedQty: 1 }],
    );
    if (created.status !== 'ok') throw new Error('create failed');
    const id = created.production.id;

    await softDeleteRecipe(db, ORG_A, aId);
    const incompleteDetail = await getManagerProduction(db, ORG_A, id);
    expect(incompleteDetail?.explosion.complete).toBe(false);
    expect(incompleteDetail?.cost.costCents).toBeNull();
    const freshNow = (
      await db.select().from(productionsTable).where(eq(productionsTable.id, id))
    )[0]!;
    expect((await planProduction(db, ORG_A, id, freshNow.updatedAt)).status).toBe(
      'incomplete',
    );

    await restoreRecipe(db, ORG_A, aId);
    expect((await getManagerProduction(db, ORG_A, id))?.explosion.complete).toBe(true);
  });

  it('blocks a recipe purge with RECIPE_IN_PRODUCTION and zero side effects', async () => {
    // A transaction referencing the recipe must NOT be unlinked on a blocked purge.
    const [cat] = await db
      .insert(categoriesTable)
      .values({ organizationId: ORG_A, name: 'Sales', kind: 'income' })
      .returning();
    const [txn] = await db
      .insert(transactionsTable)
      .values({
        organizationId: ORG_A,
        type: 'income',
        categoryId: cat!.id,
        recipeId: aId,
        occurredOn: '2026-06-01',
        amountCents: 500,
      })
      .returning();

    const created = await createProduction(
      db,
      ORG_A,
      { reference: null, notes: null, plannedFor: null },
      [{ recipeId: aId, plannedQty: 1 }],
    );
    if (created.status !== 'ok') throw new Error('create failed');
    await softDeleteRecipe(db, ORG_A, aId);

    expect(await countProductionsUsingRecipe(db, ORG_A, aId)).toBe(1);
    expect(await purgeRecipeWithGuards(db, ORG_A, aId)).toBe('in_production');

    const [after] = await db
      .select({ recipeId: transactionsTable.recipeId })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, txn!.id));
    expect(after?.recipeId).toBe(aId); // untouched
  });

  it('soft-delete/restore/purge; a young trashed production still pins its recipe', async () => {
    const created = await createProduction(
      db,
      ORG_A,
      { reference: 'P', notes: null, plannedFor: null },
      [{ recipeId: aId, plannedQty: 1 }],
    );
    if (created.status !== 'ok') throw new Error('create failed');
    const id = created.production.id;

    const del = await softDeleteProduction(db, ORG_A, id, created.production.updatedAt);
    expect(del.status).toBe('ok');
    expect((await listKitchenProductions(db, ORG_A)).find((p) => p.id === id)).toBeUndefined();
    expect((await listTrashedProductions(db, ORG_A)).map((p) => p.id)).toContain(id);

    // A trashed-but-young production still blocks the recipe purge (D4).
    await softDeleteRecipe(db, ORG_A, aId);
    expect(await purgeRecipeWithGuards(db, ORG_A, aId)).toBe('in_production');
    await restoreRecipe(db, ORG_A, aId);

    const restored = await restoreProduction(db, ORG_A, id);
    expect(restored?.status).toBe('draft'); // prior status preserved

    // Purge removes it and cascades its items.
    const fresh = (
      await db.select().from(productionsTable).where(eq(productionsTable.id, id))
    )[0]!;
    await softDeleteProduction(db, ORG_A, id, fresh.updatedAt);
    await purgeProduction(db, ORG_A, id);
    const items = await db
      .select()
      .from(productionItemsTable)
      .where(eq(productionItemsTable.productionId, id));
    expect(items).toHaveLength(0);
  });

  it('auto-purge removes an expired production before a recipe it formerly pinned', async () => {
    const created = await createProduction(
      db,
      ORG_A,
      { reference: 'old', notes: null, plannedFor: null },
      [{ recipeId: aId, plannedQty: 1 }],
    );
    if (created.status !== 'ok') throw new Error('create failed');
    const id = created.production.id;

    // Expire both the production and the recipe.
    const old = daysAgo(TRASH_RETENTION_DAYS + 1);
    await db
      .update(productionsTable)
      .set({ deletedAt: old })
      .where(eq(productionsTable.id, id));
    await softDeleteRecipe(db, ORG_A, aId);
    await db
      .update(recipesTable)
      .set({ deletedAt: old })
      .where(eq(recipesTable.id, aId));

    const result = await purgeExpired(db, ORG_A, purgeCutoff());
    expect(result.productions).toBe(1);
    expect(result.recipes).toBe(1); // freed once the production cascade released the pin
  });

  it('every read leaves the inventory ledger + stock untouched (planning, not posting)', async () => {
    const created = await createProduction(
      db,
      ORG_A,
      { reference: null, notes: null, plannedFor: '2026-07-01' },
      [{ recipeId: aId, plannedQty: 100 }], // 10000g needed vs 500g stock
    );
    if (created.status !== 'ok') throw new Error('create failed');
    await getManagerProduction(db, ORG_A, created.production.id);
    await planProduction(db, ORG_A, created.production.id, created.production.updatedAt);

    const movements = await db.select().from(movementsTable);
    expect(movements).toHaveLength(0);
    const [ing] = await db
      .select({ stock: ingredientsTable.stockQuantity })
      .from(ingredientsTable)
      .where(eq(ingredientsTable.id, aIng));
    expect(Number(ing?.stock)).toBe(500);
  });

  it('the account export (v10) includes productions + productionItems, org-scoped', async () => {
    const created = await createProduction(
      db,
      ORG_A,
      { reference: 'X', notes: null, plannedFor: null },
      [{ recipeId: aId, plannedQty: 1 }],
    );
    if (created.status !== 'ok') throw new Error('create failed');

    const bundle = await buildOrgDataExport(db, ORG_A);
    expect(bundle.schemaVersion).toBe(12);
    expect(bundle.data.productions).toHaveLength(1);
    expect(bundle.data.productionItems).toHaveLength(1);

    const bundleB = await buildOrgDataExport(db, ORG_B);
    expect(bundleB.data.productions).toHaveLength(0);
  });

  it('manager list carries cost; kitchen list is money-free', async () => {
    await createProduction(
      db,
      ORG_A,
      { reference: null, notes: null, plannedFor: null },
      [{ recipeId: aId, plannedQty: 3 }],
    );
    const mgr = await listManagerProductions(db, ORG_A);
    expect(mgr[0]?.costCents).toBe(300); // 100g×3 = 300g → 300c
    const kit = await listKitchenProductions(db, ORG_A);
    expect(JSON.stringify(kit)).not.toMatch(/cost/i);
  });

  it('isolates productions per tenant under the unprivileged role (RLS)', async () => {
    const created = await createProduction(
      db,
      ORG_A,
      { reference: null, notes: null, plannedFor: null },
      [{ recipeId: aId, plannedQty: 1 }],
    );
    if (created.status !== 'ok') throw new Error('create failed');

    await db.execute(sql.raw('SET ROLE tenant_app;'));
    try {
      const seenByB = await runInOrg(db, ORG_B, (tx) =>
        tx.select({ id: productionsTable.id }).from(productionsTable),
      );
      expect(seenByB).toHaveLength(0);
      const seenByA = await runInOrg(db, ORG_A, (tx) =>
        tx.select({ id: productionsTable.id }).from(productionsTable),
      );
      expect(seenByA.map((p) => p.id)).toContain(created.production.id);
    } finally {
      await db.execute(sql.raw('RESET ROLE;'));
    }
  });
});
