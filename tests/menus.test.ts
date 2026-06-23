import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  ingredients as ingredientsTable,
  menuItems as menuItemsTable,
  menus as menusTable,
  recipes as recipesTable,
  transactionCategories as categoriesTable,
  transactions as transactionsTable,
} from '@/lib/db/schema';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe, restoreRecipe, softDeleteRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import {
  countMenusUsingRecipe,
  createMenu,
  getKitchenMenu,
  getManagerMenu,
  listKitchenMenus,
  listManagerMenus,
  listTrashedMenus,
  purgeMenu,
  restoreMenu,
  softDeleteMenu,
  updateMenu,
} from '@/lib/data/menus';
import { purgeRecipeWithGuards } from '@/lib/data/recipe-purge';
import { purgeExpired } from '@/lib/data/trash';
import { purgeCutoff, TRASH_RETENTION_DAYS } from '@/lib/trash';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY_MS);

/** Create a `count`-dimension recipe whose single line costs `priceCents`/portion. */
async function makeRecipe(
  db: TenantDb,
  org: string,
  name: string,
  priceCents: number,
): Promise<{ recipeId: string; ingredientId: string }> {
  const ing = await createIngredient(db, org, {
    name: `${name} ingredient`,
    dimension: 'count',
    priceCents,
  });
  const recipe = await createRecipe(db, org, { name });
  const added = await addRecipeIngredient(db, org, {
    recipeId: recipe.id,
    ingredientId: ing.id,
    quantity: 1,
  });
  if (!added.ok) throw new Error('failed to add line');
  return { recipeId: recipe.id, ingredientId: ing.id };
}

describe('menus data layer', () => {
  let client: PGlite;
  let db: TenantDb;
  let aId: string; // recipe A, cost/portion 200
  let bId: string; // recipe B, cost/portion 300
  let aIngredient: string;

  beforeEach(async () => {
    const test = await createTestDb();
    client = test.client;
    db = test.db;
    const a = await makeRecipe(db, ORG_A, 'Fries', 200);
    const b = await makeRecipe(db, ORG_A, 'Burger', 300);
    aId = a.recipeId;
    aIngredient = a.ingredientId;
    bId = b.recipeId;
  });

  afterEach(async () => {
    await client.close();
  });

  it('creates a menu and derives cost = Σ recipeCost × quantity', async () => {
    const created = await createMenu(
      db,
      ORG_A,
      { name: 'Combo', sellingPriceCents: 1000, notes: null },
      [
        { recipeId: aId, quantity: 2 },
        { recipeId: bId, quantity: 1 },
      ],
    );
    expect(created.status).toBe('ok');
    if (created.status !== 'ok') return;

    const menu = await getManagerMenu(db, ORG_A, created.menu.id);
    expect(menu).not.toBeNull();
    expect(menu?.complete).toBe(true);
    expect(menu?.costCents).toBe(700); // 200×2 + 300
    expect(menu?.sellingPriceCents).toBe(1000);
    expect(menu?.foodCostPercent).toBe(70); // 700/1000
    expect(menu?.marginPercent).toBe(30);
    expect(menu?.trafficLight).toBe('red');
  });

  it('recomputes cost after an ingredient price change (derive-on-read)', async () => {
    const created = await createMenu(
      db,
      ORG_A,
      { name: 'Combo', sellingPriceCents: null, notes: null },
      [{ recipeId: aId, quantity: 1 }],
    );
    if (created.status !== 'ok') throw new Error('create failed');

    expect((await getManagerMenu(db, ORG_A, created.menu.id))?.costCents).toBe(200);

    await db
      .update(ingredientsTable)
      .set({ priceCents: 500 })
      .where(eq(ingredientsTable.id, aIngredient));

    expect((await getManagerMenu(db, ORG_A, created.menu.id))?.costCents).toBe(500);
  });

  it('rejects a trashed or cross-org recipe with invalid_recipe', async () => {
    await softDeleteRecipe(db, ORG_A, bId);
    const trashed = await createMenu(
      db,
      ORG_A,
      { name: 'X', sellingPriceCents: null, notes: null },
      [{ recipeId: bId, quantity: 1 }],
    );
    expect(trashed.status).toBe('invalid_recipe');

    const { recipeId: foreign } = await makeRecipe(db, ORG_B, 'Pizza', 100);
    const crossOrg = await createMenu(
      db,
      ORG_A,
      { name: 'Y', sellingPriceCents: null, notes: null },
      [{ recipeId: foreign, quantity: 1 }],
    );
    expect(crossOrg.status).toBe('invalid_recipe');
  });

  it('keeps a trashed component as a visible unavailable line; KPIs go null; restore recovers', async () => {
    const created = await createMenu(
      db,
      ORG_A,
      { name: 'Combo', sellingPriceCents: 1000, notes: null },
      [
        { recipeId: aId, quantity: 1 },
        { recipeId: bId, quantity: 1 },
      ],
    );
    if (created.status !== 'ok') throw new Error('create failed');
    const menuId = created.menu.id;

    await softDeleteRecipe(db, ORG_A, bId);

    const incomplete = await getManagerMenu(db, ORG_A, menuId);
    expect(incomplete?.complete).toBe(false);
    expect(incomplete?.costCents).toBeNull();
    expect(incomplete?.foodCostPercent).toBeNull();
    expect(incomplete?.marginPercent).toBeNull();
    expect(incomplete?.trafficLight).toBeNull();
    // The line is still present, marked unavailable (not dropped).
    const bLine = incomplete?.lines.find((l) => l.recipeId === bId);
    expect(bLine?.available).toBe(false);
    expect(bLine?.costPerPortionCents).toBeNull();
    expect(incomplete?.lines).toHaveLength(2);

    await restoreRecipe(db, ORG_A, bId);
    const recovered = await getManagerMenu(db, ORG_A, menuId);
    expect(recovered?.complete).toBe(true);
    expect(recovered?.costCents).toBe(500);
  });

  it('updates fields + replaces the item set in one shot', async () => {
    const created = await createMenu(
      db,
      ORG_A,
      { name: 'Combo', sellingPriceCents: 1000, notes: null },
      [{ recipeId: aId, quantity: 1 }],
    );
    if (created.status !== 'ok') throw new Error('create failed');

    const updated = await updateMenu(
      db,
      ORG_A,
      created.menu.id,
      { name: 'Combo v2', sellingPriceCents: 800, notes: 'two items' },
      [
        { recipeId: aId, quantity: 1 },
        { recipeId: bId, quantity: 2 },
      ],
    );
    expect(updated.status).toBe('ok');

    const menu = await getManagerMenu(db, ORG_A, created.menu.id);
    expect(menu?.name).toBe('Combo v2');
    expect(menu?.lines).toHaveLength(2);
    expect(menu?.costCents).toBe(200 + 300 * 2);
  });

  it('blocks a manual recipe purge while referenced by a menu, with no transaction unlink', async () => {
    const created = await createMenu(
      db,
      ORG_A,
      { name: 'Combo', sellingPriceCents: null, notes: null },
      [{ recipeId: aId, quantity: 1 }],
    );
    if (created.status !== 'ok') throw new Error('create failed');

    // Trash A and link a transaction to it, to prove the guard has zero side effects.
    await softDeleteRecipe(db, ORG_A, aId);
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

    expect(await countMenusUsingRecipe(db, ORG_A, aId)).toBe(1);
    const blocked = await purgeRecipeWithGuards(db, ORG_A, aId);
    expect(blocked).toBe('in_menu');

    // The transaction still points at the recipe — no side effect on a blocked purge.
    const [after] = await db
      .select({ recipeId: transactionsTable.recipeId })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, txn!.id));
    expect(after?.recipeId).toBe(aId);

    // After the menu is purged, the recipe purge succeeds (and nulls the txn link).
    await softDeleteMenu(db, ORG_A, created.menu.id);
    await purgeMenu(db, ORG_A, created.menu.id);
    expect(await purgeRecipeWithGuards(db, ORG_A, aId)).toBe('ok');
    const [unlinked] = await db
      .select({ recipeId: transactionsTable.recipeId })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, txn!.id));
    expect(unlinked?.recipeId).toBeNull();
  });

  it('purges expired menus before recipes; a surviving menu pins its recipe', async () => {
    // Menu M1 (expired) references A; menu M2 (active) references B.
    const m1 = await createMenu(
      db,
      ORG_A,
      { name: 'M1', sellingPriceCents: null, notes: null },
      [{ recipeId: aId, quantity: 1 }],
    );
    const m2 = await createMenu(
      db,
      ORG_A,
      { name: 'M2', sellingPriceCents: null, notes: null },
      [{ recipeId: bId, quantity: 1 }],
    );
    if (m1.status !== 'ok' || m2.status !== 'ok') throw new Error('create failed');

    // Trash + expire both recipes and M1; M2 stays active.
    await softDeleteRecipe(db, ORG_A, aId);
    await softDeleteRecipe(db, ORG_A, bId);
    for (const id of [aId, bId]) {
      await db
        .update(recipesTable)
        .set({ deletedAt: daysAgo(TRASH_RETENTION_DAYS + 1) })
        .where(eq(recipesTable.id, id));
    }
    await softDeleteMenu(db, ORG_A, m1.menu.id);
    await db
      .update(menusTable)
      .set({ deletedAt: daysAgo(TRASH_RETENTION_DAYS + 1) })
      .where(eq(menusTable.id, m1.menu.id));

    const result = await purgeExpired(db, ORG_A, purgeCutoff());
    expect(result.menus).toBe(1); // M1 purged
    expect(result.recipes).toBe(1); // only A (freed by M1's cascade); B pinned by M2
    // B is still referenced by the active M2 → kept.
    expect(await countMenusUsingRecipe(db, ORG_A, bId)).toBe(1);
  });

  it('soft-deletes, restores and purges a menu (cascading its items)', async () => {
    const created = await createMenu(
      db,
      ORG_A,
      { name: 'Combo', sellingPriceCents: null, notes: null },
      [{ recipeId: aId, quantity: 1 }],
    );
    if (created.status !== 'ok') throw new Error('create failed');
    const menuId = created.menu.id;

    expect(await softDeleteMenu(db, ORG_A, menuId)).not.toBeNull();
    expect(await getManagerMenu(db, ORG_A, menuId)).toBeNull(); // active read hides it
    expect((await listTrashedMenus(db, ORG_A)).map((m) => m.id)).toContain(menuId);

    expect(await restoreMenu(db, ORG_A, menuId)).not.toBeNull();
    expect(await getManagerMenu(db, ORG_A, menuId)).not.toBeNull();

    await softDeleteMenu(db, ORG_A, menuId);
    await purgeMenu(db, ORG_A, menuId);
    const remainingItems = await db
      .select()
      .from(menuItemsTable)
      .where(eq(menuItemsTable.menuId, menuId));
    expect(remainingItems).toHaveLength(0); // items cascaded
  });

  it('kitchen loaders never expose money keys; allergen union still works', async () => {
    const created = await createMenu(
      db,
      ORG_A,
      { name: 'Combo', sellingPriceCents: 1000, notes: 'hi' },
      [{ recipeId: aId, quantity: 2 }],
    );
    if (created.status !== 'ok') throw new Error('create failed');

    const list = await listKitchenMenus(db, ORG_A);
    const item = list.find((m) => m.id === created.menu.id);
    expect(item).toBeDefined();
    expect(Object.keys(item ?? {})).not.toContain('sellingPriceCents');
    expect(Object.keys(item ?? {})).not.toContain('costCents');
    expect(Object.keys(item ?? {})).not.toContain('kpis');

    const detail = await getKitchenMenu(db, ORG_A, created.menu.id);
    const detailJson = JSON.stringify(detail);
    expect(detailJson).not.toContain('1000'); // no price
    expect(detailJson).not.toContain('costPerPortionCents');
    expect(detail?.lines[0]?.recipeName).toBe('Fries');
  });

  it('a manager list withholds KPIs for an incomplete menu (— not 0)', async () => {
    const created = await createMenu(
      db,
      ORG_A,
      { name: 'Combo', sellingPriceCents: 1000, notes: null },
      [{ recipeId: aId, quantity: 1 }],
    );
    if (created.status !== 'ok') throw new Error('create failed');
    await softDeleteRecipe(db, ORG_A, aId);

    const list = await listManagerMenus(db, ORG_A);
    const item = list.find((m) => m.id === created.menu.id);
    expect(item?.complete).toBe(false);
    expect(item?.costCents).toBeNull();
    expect(item?.marginPercent).toBeNull();
    expect(item?.sellingPriceCents).toBe(1000); // price persists; KPIs don't
  });
});

describe('menus RLS + composite-FK isolation', () => {
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

  it('a menu_item cannot reference another org’s recipe (composite FK)', async () => {
    const { recipeId: foreign } = await makeRecipe(db, ORG_B, 'Pizza', 100);
    // A menu in ORG_A whose line points at ORG_B's recipe must be rejected.
    await expect(
      createMenu(
        db,
        ORG_A,
        { name: 'X', sellingPriceCents: null, notes: null },
        [{ recipeId: foreign, quantity: 1 }],
      ),
    ).resolves.toMatchObject({ status: 'invalid_recipe' });
  });

  it('RLS (tenant_app role) scopes an UNFILTERED menu SELECT to the active org', async () => {
    // Seed as superuser (bypasses RLS).
    const { recipeId } = await makeRecipe(db, ORG_A, 'Soup', 100);
    const created = await createMenu(
      db,
      ORG_A,
      { name: 'Soup combo', sellingPriceCents: null, notes: null },
      [{ recipeId, quantity: 1 }],
    );
    if (created.status !== 'ok') throw new Error('create failed');

    // Assume the non-privileged role so FORCE RLS is actually enforced (PGlite's
    // superuser bypasses it). An UNFILTERED select must still see only org A's rows.
    await db.execute(sql.raw('SET ROLE tenant_app;'));
    try {
      const seenByB = await runInOrg(db, ORG_B, (tx) =>
        tx.select({ id: menusTable.id }).from(menusTable),
      );
      expect(seenByB).toHaveLength(0);

      const seenByA = await runInOrg(db, ORG_A, (tx) =>
        tx.select({ id: menusTable.id }).from(menusTable),
      );
      expect(seenByA.map((m) => m.id)).toContain(created.menu.id);
    } finally {
      await db.execute(sql.raw('RESET ROLE;'));
    }
  });
});
