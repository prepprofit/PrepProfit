import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  ingredients as ingredientsTable,
  inventoryMovements as movementsTable,
  menuFolders,
  menuIngredientItems,
  menus as menusTable,
  organizationSettings,
} from '@/lib/db/schema';
import { createIngredient, trashIngredient } from '@/lib/data/ingredients';
import { createRecipe, softDeleteRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import { replaceIngredientAllergens } from '@/lib/data/allergens';
import {
  countMenusUsingRecipe,
  createDish,
  createMenuFolder,
  deleteMenuFolder,
  getKitchenDish,
  getManagerDish,
  listDishBuilderOptions,
  listKitchenDishes,
  listManagerDishes,
  listMenuFolders,
  markDishOpened,
  purgeMenu,
  searchDishes,
  softDeleteMenu,
  updateDish,
} from '@/lib/data/menus';
import { createSale, postSale, type SaleLineInput } from '@/lib/data/sales';
import type { DishFormInput } from '@/lib/validation/menus';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

/**
 * A 1 kg / 10-portion sponge (500 g flour at €2/kg → €1.00 batch, 10c/portion),
 * fresh fruit (€12/kg) and a cake box (50c each).
 */
async function seed(db: TenantDb, org = ORG_A) {
  const flour = await createIngredient(db, org, { name: 'Flour', dimension: 'weight', priceCents: 200 });
  const fruit = await createIngredient(db, org, { name: 'Passion fruit', dimension: 'weight', priceCents: 1_200 });
  const box = await createIngredient(db, org, { name: 'Cake box', dimension: 'count', priceCents: 50 });
  const sponge = await createRecipe(db, org, { name: 'Chocolate sponge', yieldPortions: 10, yieldWeightGrams: 1_000 });
  const added = await addRecipeIngredient(db, org, { recipeId: sponge.id, ingredientId: flour.id, quantity: 500 });
  if (!added.ok) throw new Error('failed to add line');
  return { flour, fruit, box, sponge };
}

function cake(ids: Awaited<ReturnType<typeof seed>>, patch: Partial<DishFormInput> = {}): DishFormInput {
  return {
    name: 'Passion fruit chocolate cake',
    folderId: null,
    portions: 4,
    sellingPriceCents: 300,
    vatRateBps: 1_300,
    notes: null,
    recipeLines: [{ recipeId: ids.sponge.id, quantity: 400, unit: 'g' }],
    ingredientLines: [
      { ingredientId: ids.fruit.id, quantity: 0.1, unit: 'kg' },
      { ingredientId: ids.box.id, quantity: 4, unit: 'piece' },
    ],
    ...patch,
  };
}

describe('dish builder data layer', () => {
  let client: PGlite;
  let db: TenantDb;
  let ids: Awaited<ReturnType<typeof seed>>;

  beforeEach(async () => {
    const test = await createTestDb();
    client = test.client;
    db = test.db;
    ids = await seed(db);
  });

  afterEach(async () => {
    await client.close();
  });

  it('creates a dish from recipe grams + direct ingredients and costs it live', async () => {
    const created = await createDish(db, ORG_A, cake(ids));
    expect(created.status).toBe('ok');
    if (created.status !== 'ok') return;

    const detail = await getManagerDish(db, ORG_A, created.menu.id);
    expect(detail?.recipeLines).toEqual([
      { recipeId: ids.sponge.id, recipeName: 'Chocolate sponge', quantity: 400, unit: 'g', available: true },
    ]);
    // Stored canonical (100 g), shown back in the unit it was entered in.
    expect(detail?.ingredientLines[0]).toMatchObject({ quantity: 0.1, unit: 'kg' });

    const [row] = await listManagerDishes(db, ORG_A, null, 'modified');
    // sponge 400 g = 4 portions × 10c = 40c; fruit 100 g × €12/kg = 120c; 4 boxes = 200c
    // → 360c / 4 portions = 90c; margin (300 − 90) / 300 = 70%.
    expect(row).toMatchObject({ costPerPortionCents: 90, sellingPriceCents: 300, marginBps: 7_000, componentCount: 3 });

    // Cost is never stored: an ingredient price change re-costs the dish on read.
    await db.update(ingredientsTable).set({ priceCents: 100 }).where(eq(ingredientsTable.id, ids.box.id));
    const [after] = await listManagerDishes(db, ORG_A, null, 'modified');
    expect(after?.costPerPortionCents).toBe(140); // boxes 50c → 100c each: (40 + 120 + 400) / 4
  });

  it('exposes builder options with cost per kg and per portion', async () => {
    const options = await listDishBuilderOptions(db, ORG_A);
    expect(options.recipes).toEqual([
      expect.objectContaining({ id: ids.sponge.id, costPerPortionCents: 10, costPerKgCents: 100, yieldWeightGrams: 1_000 }),
    ]);
    expect(options.ingredients.map((i) => i.name)).toEqual(['Cake box', 'Flour', 'Passion fruit']);
  });

  it('keeps the cost unknown when an ingredient needs pricing', async () => {
    await createDish(db, ORG_A, cake(ids));
    await db.update(ingredientsTable).set({ needsPricing: true }).where(eq(ingredientsTable.id, ids.fruit.id));
    const [row] = await listManagerDishes(db, ORG_A, null, 'modified');
    expect(row?.costPerPortionCents).toBeNull();
    expect(row?.marginBps).toBeNull();
  });

  it('rejects trashed/cross-org references, unit mismatches and unknown folders', async () => {
    const other = await seed(db, ORG_B);
    expect(await createDish(db, ORG_A, cake(ids, { recipeLines: [{ recipeId: other.sponge.id, quantity: 1, unit: 'portion' }] }))).toEqual({ status: 'invalid_recipe' });
    expect(await createDish(db, ORG_A, cake(ids, { ingredientLines: [{ ingredientId: other.box.id, quantity: 1, unit: 'piece' }] }))).toEqual({ status: 'invalid_ingredient' });
    expect(await createDish(db, ORG_A, cake(ids, { ingredientLines: [{ ingredientId: ids.box.id, quantity: 1, unit: 'kg' }] }))).toEqual({ status: 'invalid_ingredient' });
    const foreignFolder = await createMenuFolder(db, ORG_B, 'Bakery');
    expect(await createDish(db, ORG_A, cake(ids, { folderId: foreignFolder.id }))).toEqual({ status: 'invalid_folder' });

    await softDeleteRecipe(db, ORG_A, ids.sponge.id);
    expect(await createDish(db, ORG_A, cake(ids))).toEqual({ status: 'invalid_recipe' });
  });

  it('allows an empty draft dish (cost simply unknown)', async () => {
    const created = await createDish(db, ORG_A, cake(ids, { recipeLines: [], ingredientLines: [], sellingPriceCents: null }));
    expect(created.status).toBe('ok');
    const [row] = await listManagerDishes(db, ORG_A, null, 'modified');
    expect(row).toMatchObject({ componentCount: 0, costPerPortionCents: null });
  });

  it('replaces the whole composition on update and refuses a trashed dish', async () => {
    const created = await createDish(db, ORG_A, cake(ids));
    if (created.status !== 'ok') throw new Error('create failed');
    const updated = await updateDish(
      db,
      ORG_A,
      created.menu.id,
      cake(ids, { portions: 10, recipeLines: [{ recipeId: ids.sponge.id, quantity: 10, unit: 'portion' }], ingredientLines: [] }),
    );
    expect(updated.status).toBe('ok');
    const detail = await getManagerDish(db, ORG_A, created.menu.id);
    expect(detail?.portions).toBe(10);
    expect(detail?.ingredientLines).toEqual([]);
    const [row] = await listManagerDishes(db, ORG_A, null, 'modified');
    expect(row?.costPerPortionCents).toBe(10);

    await softDeleteMenu(db, ORG_A, created.menu.id);
    expect(await updateDish(db, ORG_A, created.menu.id, cake(ids))).toEqual({ status: 'not_found' });
    expect(await getManagerDish(db, ORG_B, created.menu.id)).toBeNull();
  });

  it('lists folders with counts, files dishes and moves them to Unfiled on delete', async () => {
    const bakery = await createMenuFolder(db, ORG_A, 'Bakery');
    await createMenuFolder(db, ORG_A, 'Catering');
    await createDish(db, ORG_A, cake(ids, { folderId: bakery.id }));
    const trashed = await createDish(db, ORG_A, cake(ids, { name: 'Old cake', folderId: bakery.id }));
    if (trashed.status !== 'ok') throw new Error('create failed');
    await softDeleteMenu(db, ORG_A, trashed.menu.id);
    await createDish(db, ORG_A, cake(ids, { name: 'Loose tart' }));

    expect(await listMenuFolders(db, ORG_A)).toEqual({
      folders: [
        { id: bakery.id, name: 'Bakery', dishCount: 1 },
        expect.objectContaining({ name: 'Catering', dishCount: 0 }),
      ],
      unfiledCount: 1,
    });
    expect((await listKitchenDishes(db, ORG_A, bakery.id, 'name')).map((d) => d.name)).toEqual([
      'Passion fruit chocolate cake',
    ]);

    await expect(createMenuFolder(db, ORG_A, 'Bakery')).rejects.toThrow();

    const result = await deleteMenuFolder(db, ORG_A, bakery.id);
    expect(result).toEqual({ deleted: true, movedDishes: 2 }); // active + trashed
    expect((await listMenuFolders(db, ORG_A)).unfiledCount).toBe(2);
    expect(await deleteMenuFolder(db, ORG_B, bakery.id)).toEqual({ deleted: false, movedDishes: 0 });
  });

  it('searches every dish in the org regardless of folder, typo-tolerant, excluding trash', async () => {
    const bakery = await createMenuFolder(db, ORG_A, 'Bakery');
    await createDish(db, ORG_A, cake(ids, { folderId: bakery.id }));
    await createDish(db, ORG_A, cake(ids, { name: 'Chocolate tart' }));
    const gone = await createDish(db, ORG_A, cake(ids, { name: 'Chocolate mousse' }));
    if (gone.status !== 'ok') throw new Error('create failed');
    await softDeleteMenu(db, ORG_A, gone.menu.id);
    const other = await seed(db, ORG_B);
    await createDish(db, ORG_B, cake(other, { name: 'Chocolate bomb' }));

    const results = await searchDishes(db, ORG_A, 'chocolate');
    expect(results.map((r) => r.name).sort()).toEqual(['Chocolate tart', 'Passion fruit chocolate cake']);
    expect(results.find((r) => r.name === 'Passion fruit chocolate cake')?.folderName).toBe('Bakery');
    // Prefix matches rank first.
    expect(results[0]?.name).toBe('Chocolate tart');
    expect((await searchDishes(db, ORG_A, 'chocolat cake')).map((r) => r.name)).toContain('Passion fruit chocolate cake');
    // LIKE metacharacters are literal.
    expect(await searchDishes(db, ORG_A, '%')).toEqual([]);
  });

  it('sorts by name, created, modified and last opened — opening is not a modification', async () => {
    const a = await createDish(db, ORG_A, cake(ids, { name: 'B dish' }));
    const b = await createDish(db, ORG_A, cake(ids, { name: 'A dish' }));
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('create failed');
    await db.update(menusTable).set({
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
      lastOpenedAt: null,
    }).where(eq(menusTable.id, a.menu.id));
    await db.update(menusTable).set({
      createdAt: new Date('2026-02-01'),
      updatedAt: new Date('2026-02-01'),
      lastOpenedAt: null,
    }).where(eq(menusTable.id, b.menu.id));

    const names = async (sort: 'name' | 'created' | 'modified' | 'opened') =>
      (await listKitchenDishes(db, ORG_A, null, sort)).map((d) => d.name);
    expect(await names('name')).toEqual(['A dish', 'B dish']);
    expect(await names('created')).toEqual(['A dish', 'B dish']);
    expect(await names('modified')).toEqual(['A dish', 'B dish']);

    await markDishOpened(db, ORG_A, a.menu.id);
    // 'B dish' was just opened → first; the never-opened dish sorts last.
    expect(await names('opened')).toEqual(['B dish', 'A dish']);
    const [row] = await db.select().from(menusTable).where(eq(menusTable.id, a.menu.id));
    expect(row?.updatedAt.toISOString()).toBe(new Date('2026-01-01').toISOString());
    expect(row?.lastOpenedAt).not.toBeNull();
  });

  it('gives the kitchen a money-free dish with allergens from direct ingredients', async () => {
    await replaceIngredientAllergens(db, ORG_A, ids.fruit.id, [{ allergen: 'sulphites', presence: 'may_contain' }], 'user_1');
    const created = await createDish(db, ORG_A, cake(ids));
    if (created.status !== 'ok') throw new Error('create failed');
    const dish = await getKitchenDish(db, ORG_A, created.menu.id);
    expect(dish?.allergens).toEqual([{ allergen: 'sulphites', presence: 'may_contain' }]);
    expect(dish?.hasUnreviewedIngredient).toBe(true); // flour + box never reviewed
    expect(dish && 'sellingPriceCents' in dish).toBe(false);
    const [listed] = await listKitchenDishes(db, ORG_A, null, 'name');
    expect(listed && 'costPerPortionCents' in listed).toBe(false);
  });

  it('blocks trashing an ingredient used by an active dish, and cascades lines on purge', async () => {
    const created = await createDish(db, ORG_A, cake(ids));
    if (created.status !== 'ok') throw new Error('create failed');
    expect((await trashIngredient(db, ORG_A, ids.box.id)).status).toBe('in_use');
    expect(await countMenusUsingRecipe(db, ORG_A, ids.sponge.id)).toBe(1);

    await softDeleteMenu(db, ORG_A, created.menu.id);
    expect((await trashIngredient(db, ORG_A, ids.box.id)).status).toBe('done');

    await purgeMenu(db, ORG_A, created.menu.id);
    expect(await db.select().from(menuIngredientItems)).toEqual([]);
    expect(await countMenusUsingRecipe(db, ORG_A, ids.sponge.id)).toBe(0);
  });

  it('depletes stock for a sold dish: recipe grams + direct ingredients, per portion', async () => {
    await db.insert(organizationSettings).values({ organizationId: ORG_A, defaultTaxRateBps: 1_300 });
    for (const [id, stock] of [[ids.flour.id, 1_000], [ids.fruit.id, 1_000], [ids.box.id, 10]] as const) {
      await db.update(ingredientsTable).set({ stockQuantity: String(stock) }).where(eq(ingredientsTable.id, id));
    }
    const created = await createDish(db, ORG_A, cake(ids));
    if (created.status !== 'ok') throw new Error('create failed');

    const line: SaleLineInput = {
      itemKind: 'menu',
      itemRecipeId: null,
      itemMenuId: created.menu.id,
      itemIngredientId: null,
      quantity: 2, // 2 of the 4 portions → half the composition
      ingredientQtyCanonical: null,
      unitNetCents: 300,
      taxRateBps: 1_300,
    };
    const sale = await createSale(db, ORG_A, { saleDate: '2026-07-01', note: null }, [line]);
    if (sale.status !== 'ok') throw new Error(`sale failed: ${sale.status}`);
    const posted = await runInOrg(db, ORG_A, (tx) => postSale(tx, ORG_A, sale.sale.id, sale.sale.updatedAt));
    expect(posted.status).toBe('ok');

    const moves = await db
      .select()
      .from(movementsTable)
      .where(and(eq(movementsTable.organizationId, ORG_A), eq(movementsTable.sourceId, sale.sale.id)));
    const delta = new Map(moves.map((m) => [m.ingredientId, Number(m.deltaCanonical)]));
    // sponge 400 g → 4 portions → ×½ = 2 portions = 100 g flour; fruit 100 g ×½; 4 boxes ×½.
    expect(delta.get(ids.flour.id)).toBe(-100);
    expect(delta.get(ids.fruit.id)).toBe(-50);
    expect(delta.get(ids.box.id)).toBe(-2);
  });
});

describe('dish tables RLS + composite FKs (tenant_app role)', () => {
  let client: PGlite;
  let db: TenantDb;

  beforeEach(async () => {
    const test = await createTestDb();
    client = test.client;
    db = test.db;
  });

  afterEach(async () => {
    await db.execute(sql.raw('RESET ROLE;'));
    await client.close();
  });

  it('isolates menu_folders and menu_ingredient_items for SELECT, INSERT, UPDATE and DELETE', async () => {
    const ids = await seed(db);
    const folder = await createMenuFolder(db, ORG_A, 'Bakery');
    const created = await createDish(db, ORG_A, cake(ids, { folderId: folder.id }));
    if (created.status !== 'ok') throw new Error('create failed');

    await db.execute(sql.raw('SET ROLE tenant_app;'));
    for (const table of [menuFolders, menuIngredientItems]) {
      expect(await runInOrg(db, ORG_B, (tx) => tx.select().from(table))).toHaveLength(0);
      expect((await runInOrg(db, ORG_A, (tx) => tx.select().from(table))).length).toBeGreaterThan(0);
      expect(await runInOrg(db, ORG_B, (tx) => tx.delete(table).returning())).toHaveLength(0);
    }
    expect(
      await runInOrg(db, ORG_B, (tx) => tx.update(menuFolders).set({ name: 'Hijacked' }).returning()),
    ).toHaveLength(0);
    await expect(
      runInOrg(db, ORG_B, (tx) => tx.insert(menuFolders).values({ organizationId: ORG_A, name: 'Sneaky' })),
    ).rejects.toThrow();
    await expect(
      runInOrg(db, ORG_A, (tx) => tx.update(menuFolders).set({ organizationId: ORG_B }).returning()),
    ).rejects.toThrow();
  });

  it('refuses a dish line or folder that points at another org (composite FKs)', async () => {
    const a = await seed(db, ORG_A);
    const b = await seed(db, ORG_B);
    const created = await createDish(db, ORG_A, cake(a));
    if (created.status !== 'ok') throw new Error('create failed');
    const foreignFolder = await createMenuFolder(db, ORG_B, 'Theirs');

    await expect(
      db.insert(menuIngredientItems).values({
        organizationId: ORG_A,
        menuId: created.menu.id,
        ingredientId: b.box.id,
        quantity: 1,
        unit: 'piece',
      }),
    ).rejects.toThrow();
    await expect(
      db.update(menusTable).set({ folderId: foreignFolder.id }).where(eq(menusTable.id, created.menu.id)),
    ).rejects.toThrow();
  });
});
