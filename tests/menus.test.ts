import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  ingredients as ingredientsTable,
  inventoryMovements as movementsTable,
  menuExtras,
  menuFolders,
  menuIngredientItems,
  menus as menusTable,
  organizationSettings,
  recipes as recipesTable,
} from '@/lib/db/schema';
import { createIngredient, trashIngredient } from '@/lib/data/ingredients';
import { createRecipe, softDeleteRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import { addRecipeComponent } from '@/lib/data/recipe-components';
import { replaceIngredientAllergens } from '@/lib/data/allergens';
import { catalogueDishCosts, catalogueDishCostPerSaleUnit, loadActiveCatalogue } from '@/lib/data/active-catalogue';
import {
  countMenusUsingRecipe,
  createDish,
  createMenuFolder,
  deleteMenuFolder,
  duplicateDish,
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
import { dishSchema, type DishFormInput } from '@/lib/validation/menus';

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

type Ids = Awaited<ReturnType<typeof seed>>;

/** A 4-portion cake: 400 g sponge (40c) + 100 g fruit (120c) + 4 boxes (200c) = 360c. */
function cake(ids: Ids, patch: Partial<DishFormInput> = {}): DishFormInput {
  return {
    name: 'Passion fruit chocolate cake',
    folderId: null,
    output: { quantity: 4, unit: 'portion', sizeDescription: null, finishedWeightGrams: null },
    sellingPriceCents: 300,
    priceBasis: 'unit',
    vatRateBps: 1_300,
    labour: null,
    extras: [],
    notes: null,
    recipeLines: [{ recipeId: ids.sponge.id, quantity: 400, unit: 'g' }],
    ingredientLines: [
      { ingredientId: ids.fruit.id, quantity: 0.1, unit: 'kg' },
      { ingredientId: ids.box.id, quantity: 4, unit: 'piece' },
    ],
    ...patch,
  };
}

describe('menu product data layer', () => {
  let client: PGlite;
  let db: TenantDb;
  let ids: Ids;

  beforeEach(async () => {
    const test = await createTestDb();
    client = test.client;
    db = test.db;
    ids = await seed(db);
  });

  afterEach(async () => {
    await client.close();
  });

  it('costs a legacy portion product exactly as before (blank labour)', async () => {
    const created = await createDish(db, ORG_A, cake(ids));
    expect(created.status).toBe('ok');
    const [row] = await listManagerDishes(db, ORG_A, null, 'modified');
    // 360c / 4 portions = 90c; (300 − 90) / 300 = 70%.
    expect(row).toMatchObject({ costPerSaleUnitCents: 90, sellingPriceCents: 300, marginBps: 7_000, componentCount: 3 });
    expect(row?.output).toEqual({ quantity: 4, unit: 'portion', sizeDescription: null, finishedWeightGrams: null });

    // Cost is never stored: an ingredient price change re-costs on read.
    await db.update(ingredientsTable).set({ priceCents: 100 }).where(eq(ingredientsTable.id, ids.box.id));
    const [after] = await listManagerDishes(db, ORG_A, null, 'modified');
    expect(after?.costPerSaleUnitCents).toBe(140); // (40 + 120 + 400) / 4
  });

  it('saves and reopens every new field', async () => {
    const created = await createDish(
      db,
      ORG_A,
      cake(ids, {
        output: { quantity: 50, unit: 'cake', sizeDescription: '18 cm', finishedWeightGrams: 25_000 },
        labour: { hours: 7.5, hourlyCents: 1_850 },
        extras: [
          { kind: 'work', description: 'Driving', hours: 2.25, hourlyCents: 2_000 },
          { kind: 'expense', description: 'Parking', amountCents: 1_500 },
        ],
        notes: 'Soho, 9 November',
      }),
    );
    if (created.status !== 'ok') throw new Error('create failed');
    const detail = await getManagerDish(db, ORG_A, created.menu.id);
    expect(detail).toMatchObject({
      output: { quantity: 50, unit: 'cake', sizeDescription: '18 cm', finishedWeightGrams: 25_000 },
      priceBasis: 'unit',
      labour: { hours: 7.5, hourlyCents: 1_850 },
      extras: [
        { kind: 'work', description: 'Driving', hours: 2.25, hourlyCents: 2_000 },
        { kind: 'expense', description: 'Parking', amountCents: 1_500 },
      ],
      notes: 'Soho, 9 November',
    });
    // Recipe grams + ingredient kg display back in the entered units.
    expect(detail?.recipeLines[0]).toMatchObject({ quantity: 400, unit: 'g' });
    expect(detail?.ingredientLines[0]).toMatchObject({ quantity: 0.1, unit: 'kg' });

    // Edit + remove an extra, then reopen.
    const updated = await updateDish(
      db,
      ORG_A,
      created.menu.id,
      cake(ids, {
        output: { quantity: 50, unit: 'cake', sizeDescription: '18 cm', finishedWeightGrams: 25_000 },
        labour: { hours: 8, hourlyCents: 2_000 },
        extras: [{ kind: 'expense', description: 'Parking (2 days)', amountCents: 3_000 }],
      }),
    );
    expect(updated.status).toBe('ok');
    const reopened = await getManagerDish(db, ORG_A, created.menu.id);
    expect(reopened?.extras).toEqual([{ kind: 'expense', description: 'Parking (2 days)', amountCents: 3_000 }]);
    expect(reopened?.labour).toEqual({ hours: 8, hourlyCents: 2_000 });
  });

  it('weight batch: kg and g store the same batch and give identical results', async () => {
    const inKg = await createDish(
      db,
      ORG_A,
      cake(ids, {
        name: 'Gelato (kg)',
        output: { quantity: 20, unit: 'kg', sizeDescription: null, finishedWeightGrams: null },
        priceBasis: 'kg',
        sellingPriceCents: 800,
        labour: { hours: 1, hourlyCents: 2_000 },
      }),
    );
    const inG = await createDish(
      db,
      ORG_A,
      cake(ids, {
        name: 'Gelato (g)',
        output: { quantity: 20_000, unit: 'g', sizeDescription: null, finishedWeightGrams: null },
        priceBasis: 'kg',
        sellingPriceCents: 800,
        labour: { hours: 1, hourlyCents: 2_000 },
      }),
    );
    if (inKg.status !== 'ok' || inG.status !== 'ok') throw new Error('create failed');
    expect(inKg.menu.outputQuantity).toBe(20_000);
    expect(inG.menu.outputQuantity).toBe(20_000);

    const costs = catalogueDishCosts(await loadActiveCatalogue(db, ORG_A));
    const a = costs.get(inKg.menu.id);
    const b = costs.get(inG.menu.id);
    // components 360c (labour excluded — the sponge has none) + €20 labour = 2360c / 20 kg
    expect(a?.totalCostCents).toBe(2_360);
    expect(a?.costPerKgCents).toBe(118);
    expect(b?.totalCostCents).toBe(a?.totalCostCents);
    expect(b?.costPerSaleUnitCents).toBe(a?.costPerSaleUnitCents);
  });

  it('dish editor: changing portions redistributes cost and never rescales quantities', async () => {
    const created = await createDish(db, ORG_A, cake(ids, { labour: { hours: 1, hourlyCents: 2_000 } }));
    if (created.status !== 'ok') throw new Error('create failed');
    const before = await getManagerDish(db, ORG_A, created.menu.id);
    const updated = await updateDish(
      db,
      ORG_A,
      created.menu.id,
      cake(ids, { output: { quantity: 8, unit: 'portion', sizeDescription: null, finishedWeightGrams: null }, labour: { hours: 1, hourlyCents: 2_000 } }),
    );
    expect(updated.status).toBe('ok');
    const after = await getManagerDish(db, ORG_A, created.menu.id);
    expect(after?.recipeLines).toEqual(before?.recipeLines);
    expect(after?.ingredientLines).toEqual(before?.ingredientLines);
    expect(after?.labour).toEqual(before?.labour);

    const cost = catalogueDishCosts(await loadActiveCatalogue(db, ORG_A)).get(created.menu.id);
    // 360c components + 2000c labour, the same total — now spread over 8 portions.
    expect(cost?.totalCostCents).toBe(2_360);
    expect(cost?.costPerSaleUnitCents).toBe(295);
  });

  it('dish editor: converting a weight batch to portions keeps composition and weight', async () => {
    const weight = await createDish(
      db,
      ORG_A,
      cake(ids, {
        name: 'Gelato',
        output: { quantity: 20, unit: 'kg', sizeDescription: null, finishedWeightGrams: null },
        priceBasis: 'kg',
        sellingPriceCents: 800,
        labour: { hours: 1, hourlyCents: 2_000 },
        extras: [{ kind: 'expense', description: 'Tubs', amountCents: 400 }],
      }),
    );
    if (weight.status !== 'ok') throw new Error('create failed');
    const before = await getManagerDish(db, ORG_A, weight.menu.id);

    // What the editor sends after "Use portions": 80 portions at €2.50, weight kept.
    const converted = await updateDish(
      db,
      ORG_A,
      weight.menu.id,
      cake(ids, {
        name: 'Gelato',
        output: { quantity: 80, unit: 'portion', sizeDescription: null, finishedWeightGrams: 20_000 },
        priceBasis: 'unit',
        sellingPriceCents: 250,
        labour: { hours: 1, hourlyCents: 2_000 },
        extras: [{ kind: 'expense', description: 'Tubs', amountCents: 400 }],
      }),
    );
    expect(converted.status).toBe('ok');
    const after = await getManagerDish(db, ORG_A, weight.menu.id);
    expect(after).toMatchObject({
      output: { quantity: 80, unit: 'portion', finishedWeightGrams: 20_000 },
      priceBasis: 'unit',
      sellingPriceCents: 250,
    });
    expect(after?.recipeLines).toEqual(before?.recipeLines);
    expect(after?.ingredientLines).toEqual(before?.ingredientLines);
    expect(after?.extras).toEqual(before?.extras);

    const cost = catalogueDishCosts(await loadActiveCatalogue(db, ORG_A)).get(weight.menu.id);
    expect(cost?.totalCostCents).toBe(2_760); // unchanged total: 360 + 2000 + 400
    expect(cost?.costPerSaleUnitCents).toBe(35); // 2760 / 80 = 34.5 → 35
    expect(cost?.costPerKgCents).toBe(138); // the kept weight still gives cost per kg
  });

  it('never double-counts recipe labour (incl. nested) and keeps energy + packaging', async () => {
    // Base: sub-recipe with 300c labour; parent uses 500 g of it (half the batch) and
    // has its own 400c labour, 100c energy, 60c packaging.
    await db.update(recipesTable).set({ laborCostCents: 300 }).where(eq(recipesTable.id, ids.sponge.id));
    const parent = await createRecipe(db, ORG_A, {
      name: 'Layered base',
      yieldPortions: 2,
      yieldWeightGrams: 800,
      laborCostCents: 400,
      energyCostCents: 100,
      packagingCostCents: 60,
    });
    const linked = await addRecipeComponent(db, ORG_A, parent.id, { componentRecipeId: ids.sponge.id, quantityGrams: 500 });
    expect(linked.ok).toBe(true);

    const base = {
      output: { quantity: 2, unit: 'portion' as const, sizeDescription: null, finishedWeightGrams: null },
      recipeLines: [{ recipeId: parent.id, quantity: 2, unit: 'portion' as const }],
      ingredientLines: [],
    };
    const legacy = await createDish(db, ORG_A, cake(ids, { name: 'Legacy', ...base }));
    const zero = await createDish(db, ORG_A, cake(ids, { name: 'Zero labour', ...base, labour: { hours: 0, hourlyCents: 0 } }));
    const withLabour = await createDish(db, ORG_A, cake(ids, { name: 'With labour', ...base, labour: { hours: 1, hourlyCents: 1_000 } }));
    if (legacy.status !== 'ok' || zero.status !== 'ok' || withLabour.status !== 'ok') throw new Error('create failed');

    const costs = catalogueDishCosts(await loadActiveCatalogue(db, ORG_A));
    // Parent batch: sponge half = flour 50c + labour 150c; own labour 400 + energy 100 + packaging 60.
    expect(costs.get(legacy.menu.id)).toMatchObject({ totalCostCents: 760, labourMode: 'inherited', inheritsRecipeLabour: true });
    // Labour excluded (own 400 + nested 150) → 50 + 100 + 60 = 210, energy + packaging kept.
    expect(costs.get(zero.menu.id)).toMatchObject({ totalCostCents: 210, productionLabourCents: 0, labourMode: 'menu' });
    expect(costs.get(withLabour.menu.id)).toMatchObject({ componentsCents: 210, productionLabourCents: 1_000, totalCostCents: 1_210 });

    // The underlying recipes are untouched.
    const [p] = await db.select().from(recipesTable).where(eq(recipesTable.id, parent.id));
    expect(p?.laborCostCents).toBe(400);
  });

  it('builder options expose recipe costs with and without labour', async () => {
    await db.update(recipesTable).set({ laborCostCents: 500 }).where(eq(recipesTable.id, ids.sponge.id));
    const options = await listDishBuilderOptions(db, ORG_A);
    expect(options.recipes).toEqual([
      expect.objectContaining({
        id: ids.sponge.id,
        costPerPortionCents: 60,
        costPerPortionWithoutLabourCents: 10,
        costPerKgCents: 600,
        costPerKgWithoutLabourCents: 100,
      }),
    ]);
  });

  it('copies a product independently of the original', async () => {
    const folder = await createMenuFolder(db, ORG_A, 'Catering');
    const created = await createDish(
      db,
      ORG_A,
      cake(ids, {
        folderId: folder.id,
        output: { quantity: 300, unit: 'piece', sizeDescription: 'mini', finishedWeightGrams: 9_000 },
        labour: { hours: 8, hourlyCents: 2_000 },
        extras: [{ kind: 'work', description: 'Driving', hours: 2, hourlyCents: 2_000 }],
        notes: 'Base version',
      }),
    );
    if (created.status !== 'ok') throw new Error('create failed');

    const copy = await duplicateDish(db, ORG_A, created.menu.id, 'Mini cakes — Soho, 9 November');
    if (copy.status !== 'ok') throw new Error('copy failed');
    const copied = await getManagerDish(db, ORG_A, copy.menu.id);
    const original = await getManagerDish(db, ORG_A, created.menu.id);
    expect(copied).toMatchObject({
      name: 'Mini cakes — Soho, 9 November',
      folderId: folder.id,
      output: original?.output,
      labour: original?.labour,
      extras: original?.extras,
      sellingPriceCents: 300,
      priceBasis: 'unit',
      notes: 'Base version',
      recipeLines: original?.recipeLines,
      ingredientLines: original?.ingredientLines,
    });

    // Editing the copy leaves the original unchanged.
    await updateDish(db, ORG_A, copy.menu.id, cake(ids, { name: 'Edited copy', labour: null, extras: [], ingredientLines: [] }));
    expect(await getManagerDish(db, ORG_A, created.menu.id)).toEqual(original);
    expect(await duplicateDish(db, ORG_B, created.menu.id, 'x')).toEqual({ status: 'not_found' });
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

  it('enforces labour pairs, price basis and finished weight at the DB layer', async () => {
    const created = await createDish(db, ORG_A, cake(ids));
    if (created.status !== 'ok') throw new Error('create failed');
    const scope = eq(menusTable.id, created.menu.id);
    await expect(db.update(menusTable).set({ labourHours: 2 }).where(scope)).rejects.toThrow();
    await expect(db.update(menusTable).set({ labourHours: -1, labourHourlyCents: 100 }).where(scope)).rejects.toThrow();
    await expect(db.update(menusTable).set({ priceBasis: 'kg' }).where(scope)).rejects.toThrow();
    await expect(db.update(menusTable).set({ outputUnit: 'g', priceBasis: 'kg', finishedWeightGrams: 100 }).where(scope)).rejects.toThrow();
    await expect(db.update(menusTable).set({ outputQuantity: 0 }).where(scope)).rejects.toThrow();
  });

  it('replaces the whole composition on update and refuses a trashed product', async () => {
    const created = await createDish(db, ORG_A, cake(ids));
    if (created.status !== 'ok') throw new Error('create failed');
    await updateDish(
      db,
      ORG_A,
      created.menu.id,
      cake(ids, {
        output: { quantity: 10, unit: 'portion', sizeDescription: null, finishedWeightGrams: null },
        recipeLines: [{ recipeId: ids.sponge.id, quantity: 10, unit: 'portion' }],
        ingredientLines: [],
      }),
    );
    const [row] = await listManagerDishes(db, ORG_A, null, 'modified');
    expect(row?.costPerSaleUnitCents).toBe(10);
    await softDeleteMenu(db, ORG_A, created.menu.id);
    expect(await updateDish(db, ORG_A, created.menu.id, cake(ids))).toEqual({ status: 'not_found' });
    expect(await getManagerDish(db, ORG_B, created.menu.id)).toBeNull();
  });

  it('lists folders with counts and moves dishes to Unfiled on delete', async () => {
    const bakery = await createMenuFolder(db, ORG_A, 'Bakery');
    await createDish(db, ORG_A, cake(ids, { folderId: bakery.id }));
    const trashed = await createDish(db, ORG_A, cake(ids, { name: 'Old cake', folderId: bakery.id }));
    if (trashed.status !== 'ok') throw new Error('create failed');
    await softDeleteMenu(db, ORG_A, trashed.menu.id);
    await createDish(db, ORG_A, cake(ids, { name: 'Loose tart' }));

    expect((await listMenuFolders(db, ORG_A)).folders).toEqual([{ id: bakery.id, name: 'Bakery', dishCount: 1 }]);
    await expect(createMenuFolder(db, ORG_A, 'Bakery')).rejects.toThrow();
    expect(await deleteMenuFolder(db, ORG_A, bakery.id)).toEqual({ deleted: true, movedDishes: 2 });
    expect((await listMenuFolders(db, ORG_A)).unfiledCount).toBe(2);
  });

  it('searches every product in the org, typo-tolerant, excluding trash', async () => {
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
    expect(results[0]?.name).toBe('Chocolate tart');
    expect(await searchDishes(db, ORG_A, '%')).toEqual([]);
  });

  it('sorts by opened without touching modified', async () => {
    const a = await createDish(db, ORG_A, cake(ids, { name: 'B dish' }));
    const b = await createDish(db, ORG_A, cake(ids, { name: 'A dish' }));
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('create failed');
    for (const [id, date] of [[a.menu.id, '2026-01-01'], [b.menu.id, '2026-02-01']] as const) {
      await db.update(menusTable).set({ createdAt: new Date(date), updatedAt: new Date(date), lastOpenedAt: null }).where(eq(menusTable.id, id));
    }
    const names = async (sort: 'name' | 'created' | 'modified' | 'opened') =>
      (await listKitchenDishes(db, ORG_A, null, sort)).map((d) => d.name);
    expect(await names('name')).toEqual(['A dish', 'B dish']);
    expect(await names('modified')).toEqual(['A dish', 'B dish']);
    await markDishOpened(db, ORG_A, a.menu.id);
    expect(await names('opened')).toEqual(['B dish', 'A dish']);
    const [row] = await db.select().from(menusTable).where(eq(menusTable.id, a.menu.id));
    expect(row?.updatedAt.toISOString()).toBe(new Date('2026-01-01').toISOString());
  });

  it('gives the kitchen output + allergens but no money, labour or extras', async () => {
    await replaceIngredientAllergens(db, ORG_A, ids.fruit.id, [{ allergen: 'sulphites', presence: 'may_contain' }], 'user_1');
    const created = await createDish(
      db,
      ORG_A,
      cake(ids, {
        output: { quantity: 50, unit: 'cake', sizeDescription: '18 cm', finishedWeightGrams: null },
        labour: { hours: 8, hourlyCents: 2_000 },
        extras: [{ kind: 'expense', description: 'Parking', amountCents: 1_500 }],
      }),
    );
    if (created.status !== 'ok') throw new Error('create failed');
    const dish = await getKitchenDish(db, ORG_A, created.menu.id);
    expect(dish?.allergens).toEqual([{ allergen: 'sulphites', presence: 'may_contain' }]);
    expect(dish?.output).toEqual({ quantity: 50, unit: 'cake', sizeDescription: '18 cm', finishedWeightGrams: null });
    for (const key of ['sellingPriceCents', 'labour', 'extras', 'priceBasis', 'vatRateBps']) {
      expect(dish && key in dish).toBe(false);
    }
    const [listed] = await listKitchenDishes(db, ORG_A, null, 'name');
    expect(listed && 'costPerSaleUnitCents' in listed).toBe(false);
  });

  it('blocks trashing an ingredient used by an active product; purge cascades lines + extras', async () => {
    const created = await createDish(db, ORG_A, cake(ids, { extras: [{ kind: 'expense', description: 'Parking', amountCents: 100 }] }));
    if (created.status !== 'ok') throw new Error('create failed');
    expect((await trashIngredient(db, ORG_A, ids.box.id)).status).toBe('in_use');
    await softDeleteMenu(db, ORG_A, created.menu.id);
    expect((await trashIngredient(db, ORG_A, ids.box.id)).status).toBe('done');
    await purgeMenu(db, ORG_A, created.menu.id);
    expect(await db.select().from(menuIngredientItems)).toEqual([]);
    expect(await db.select().from(menuExtras)).toEqual([]);
    expect(await countMenusUsingRecipe(db, ORG_A, ids.sponge.id)).toBe(0);
  });
});

describe('menu product sales', () => {
  let client: PGlite;
  let db: TenantDb;
  let ids: Ids;

  beforeEach(async () => {
    const test = await createTestDb();
    client = test.client;
    db = test.db;
    ids = await seed(db);
    await db.insert(organizationSettings).values({ organizationId: ORG_A, defaultTaxRateBps: 1_300 });
    for (const [id, stock] of [[ids.flour.id, 1_000], [ids.fruit.id, 1_000], [ids.box.id, 10]] as const) {
      await db.update(ingredientsTable).set({ stockQuantity: String(stock) }).where(eq(ingredientsTable.id, id));
    }
  });

  afterEach(async () => {
    await client.close();
  });

  async function sell(menuId: string, quantity: number, date: string) {
    const line: SaleLineInput = {
      itemKind: 'menu',
      itemRecipeId: null,
      itemMenuId: menuId,
      itemIngredientId: null,
      quantity,
      ingredientQtyCanonical: null,
      unitNetCents: 300,
      taxRateBps: 1_300,
    };
    const sale = await createSale(db, ORG_A, { saleDate: date, note: null }, [line]);
    if (sale.status !== 'ok') throw new Error(`sale failed: ${sale.status}`);
    const posted = await runInOrg(db, ORG_A, (tx) => postSale(tx, ORG_A, sale.sale.id, sale.sale.updatedAt));
    expect(posted.status).toBe('ok');
    const moves = await db
      .select()
      .from(movementsTable)
      .where(and(eq(movementsTable.organizationId, ORG_A), eq(movementsTable.sourceId, sale.sale.id)));
    return new Map(moves.map((m) => [m.ingredientId, Number(m.deltaCanonical)]));
  }

  it('count batch: a sale of 2 units draws 2/4 of the composition', async () => {
    const created = await createDish(db, ORG_A, cake(ids));
    if (created.status !== 'ok') throw new Error('create failed');
    const delta = await sell(created.menu.id, 2, '2026-07-01');
    // sponge 400 g = 4 portions → ×½ = 100 g flour; fruit 100 g ×½; 4 boxes ×½.
    expect(delta.get(ids.flour.id)).toBe(-100);
    expect(delta.get(ids.fruit.id)).toBe(-50);
    expect(delta.get(ids.box.id)).toBe(-2);
  });

  it('weight batch: quantity sold is kg of the batch, never portions', async () => {
    // The whole cake composition makes a 2 kg batch; selling 1 kg draws half of it.
    const created = await createDish(
      db,
      ORG_A,
      cake(ids, { output: { quantity: 2, unit: 'kg', sizeDescription: null, finishedWeightGrams: null }, priceBasis: 'kg' }),
    );
    if (created.status !== 'ok') throw new Error('create failed');
    const delta = await sell(created.menu.id, 1, '2026-07-02');
    expect(delta.get(ids.flour.id)).toBe(-100);
    expect(delta.get(ids.box.id)).toBe(-2);

    // Per-sale-unit cost is per kg: 360c for 2 kg → 180c/kg.
    const perUnit = catalogueDishCostPerSaleUnit(await loadActiveCatalogue(db, ORG_A));
    expect(perUnit.get(created.menu.id)).toBe(180);
  });
});

describe('menu product validation', () => {
  const ids = { sponge: { id: 'r1' }, fruit: { id: 'i1' }, box: { id: 'i2' } } as unknown as Ids;
  const valid = cake(ids);

  it('rejects partial, negative or non-finite labour and extras', () => {
    expect(dishSchema.safeParse(valid).success).toBe(true);
    expect(dishSchema.safeParse({ ...valid, labour: { hours: 0, hourlyCents: 0 } }).success).toBe(true);
    for (const labour of [
      { hours: 8 },
      { hourlyCents: 2_000 },
      { hours: -1, hourlyCents: 2_000 },
      { hours: 1, hourlyCents: -1 },
      { hours: Number.NaN, hourlyCents: 2_000 },
      { hours: 1, hourlyCents: 12.5 },
    ]) {
      expect(dishSchema.safeParse({ ...valid, labour }).success).toBe(false);
    }
    expect(dishSchema.safeParse({ ...valid, extras: [{ kind: 'work', description: '', hours: 1, hourlyCents: 1 }] }).success).toBe(false);
    expect(dishSchema.safeParse({ ...valid, extras: [{ kind: 'expense', description: 'Parking', amountCents: -5 }] }).success).toBe(false);
    expect(dishSchema.safeParse({ ...valid, extras: [{ kind: 'expense', description: 'Parking', hours: 1, amountCents: 5 }] }).success).toBe(true);
  });

  it('rounds decimal hours to the stored 2 decimals', () => {
    const parsed = dishSchema.parse({ ...valid, labour: { hours: 1.255, hourlyCents: 2_000 } });
    expect(parsed.labour?.hours).toBe(1.26);
  });

  it('requires the price basis to match the output and finished weight only for count batches', () => {
    expect(dishSchema.safeParse({ ...valid, priceBasis: 'kg' }).success).toBe(false);
    expect(
      dishSchema.safeParse({
        ...valid,
        output: { quantity: 20, unit: 'kg', sizeDescription: null, finishedWeightGrams: 20_000 },
        priceBasis: 'kg',
      }).success,
    ).toBe(false);
    expect(
      dishSchema.safeParse({
        ...valid,
        output: { quantity: 20_000, unit: 'g', sizeDescription: null, finishedWeightGrams: null },
        priceBasis: 'kg',
      }).success,
    ).toBe(true);
    expect(dishSchema.safeParse({ ...valid, output: { ...valid.output, quantity: 0 } }).success).toBe(false);
  });
});

describe('menu tables RLS + composite FKs (tenant_app role)', () => {
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

  it('isolates folders, ingredient lines and extras for SELECT, INSERT, UPDATE and DELETE', async () => {
    const ids = await seed(db);
    const folder = await createMenuFolder(db, ORG_A, 'Bakery');
    const created = await createDish(
      db,
      ORG_A,
      cake(ids, { folderId: folder.id, extras: [{ kind: 'expense', description: 'Parking', amountCents: 100 }] }),
    );
    if (created.status !== 'ok') throw new Error('create failed');

    await db.execute(sql.raw('SET ROLE tenant_app;'));
    for (const table of [menuFolders, menuIngredientItems, menuExtras]) {
      expect(await runInOrg(db, ORG_B, (tx) => tx.select().from(table))).toHaveLength(0);
      expect((await runInOrg(db, ORG_A, (tx) => tx.select().from(table))).length).toBeGreaterThan(0);
      expect(await runInOrg(db, ORG_B, (tx) => tx.delete(table).returning())).toHaveLength(0);
    }
    expect(await runInOrg(db, ORG_B, (tx) => tx.update(menuExtras).set({ amountCents: 1 }).returning())).toHaveLength(0);
    await expect(
      runInOrg(db, ORG_B, (tx) =>
        tx.insert(menuExtras).values({ organizationId: ORG_A, menuId: created.menu.id, kind: 'expense', description: 'x', amountCents: 1 }),
      ),
    ).rejects.toThrow();
    await expect(
      runInOrg(db, ORG_A, (tx) => tx.update(menuExtras).set({ organizationId: ORG_B }).returning()),
    ).rejects.toThrow();
  });

  it('refuses lines or folders that point at another org (composite FKs)', async () => {
    const a = await seed(db, ORG_A);
    const b = await seed(db, ORG_B);
    const created = await createDish(db, ORG_A, cake(a));
    const foreign = await createDish(db, ORG_B, cake(b));
    if (created.status !== 'ok' || foreign.status !== 'ok') throw new Error('create failed');
    const foreignFolder = await createMenuFolder(db, ORG_B, 'Theirs');

    await expect(
      db.insert(menuIngredientItems).values({ organizationId: ORG_A, menuId: created.menu.id, ingredientId: b.box.id, quantity: 1, unit: 'piece' }),
    ).rejects.toThrow();
    await expect(
      db.update(menusTable).set({ folderId: foreignFolder.id }).where(eq(menusTable.id, created.menu.id)),
    ).rejects.toThrow();
    await expect(
      db.insert(menuExtras).values({ organizationId: ORG_A, menuId: foreign.menu.id, kind: 'expense', description: 'x', amountCents: 1 }),
    ).rejects.toThrow();
  });
});
