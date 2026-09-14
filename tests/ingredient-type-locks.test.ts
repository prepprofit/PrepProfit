import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { recordMovement } from '@/lib/data/inventory';
import { createIngredient, listIngredientTypeLocks } from '@/lib/data/ingredients';
import { createRecipe, softDeleteRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import { createDish } from '@/lib/data/menus';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

let client: PGlite;
let db: TenantDb;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  await db.execute(sql.raw('SET ROLE tenant_app;'));
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

describe('listIngredientTypeLocks', () => {
  it('locks the type of ingredients whose quantities live in recipes, dishes or stock — per org', async () => {
    const ids = await runInOrg(db, ORG_A, async (tx) => {
      const flour = await createIngredient(tx, ORG_A, { name: 'Flour', dimension: 'weight', priceCents: 200 });
      const box = await createIngredient(tx, ORG_A, { name: 'Box', dimension: 'count', priceCents: 50 });
      const milk = await createIngredient(tx, ORG_A, { name: 'Milk', dimension: 'volume', priceCents: 120 });
      const free = await createIngredient(tx, ORG_A, { name: 'Unused', dimension: 'weight', priceCents: 0 });
      const trashedOnly = await createIngredient(tx, ORG_A, { name: 'Old', dimension: 'weight', priceCents: 0 });
      const bread = await createRecipe(tx, ORG_A, { name: 'Bread' });
      await addRecipeIngredient(tx, ORG_A, { recipeId: bread.id, ingredientId: flour.id, quantity: 500 });
      const gone = await createRecipe(tx, ORG_A, { name: 'Gone' });
      await addRecipeIngredient(tx, ORG_A, { recipeId: gone.id, ingredientId: trashedOnly.id, quantity: 5 });
      await softDeleteRecipe(tx, ORG_A, gone.id);
      await createDish(tx, ORG_A, {
        name: 'Cake', folderId: null,
        output: { quantity: 1, unit: 'portion', sizeDescription: null, finishedWeightGrams: null },
        sellingPriceCents: null, priceBasis: 'unit', vatRateBps: null, labour: null, extras: [], notes: null,
        recipeLines: [], ingredientLines: [{ ingredientId: box.id, quantity: 1, unit: 'piece' }],
      });
      await recordMovement(tx, ORG_A, {
        ingredientId: milk.id,
        deltaCanonical: 1000,
        source: { type: 'manual' },
        idempotencyKey: 'manual:type-lock-test',
      });
      return { flour, box, milk, free, trashedOnly };
    });

    const locks = await runInOrg(db, ORG_A, (tx) => listIngredientTypeLocks(tx, ORG_A));
    expect(locks.get(ids.flour.id)).toEqual({ recipes: 1, menus: 0, stock: false });
    expect(locks.get(ids.box.id)).toEqual({ recipes: 0, menus: 1, stock: false });
    expect(locks.get(ids.milk.id)).toEqual({ recipes: 0, menus: 0, stock: true });
    expect(locks.has(ids.free.id)).toBe(false);
    expect(locks.has(ids.trashedOnly.id)).toBe(false);

    const scoped = await runInOrg(db, ORG_A, (tx) => listIngredientTypeLocks(tx, ORG_A, [ids.free.id, ids.flour.id]));
    expect([...scoped.keys()]).toEqual([ids.flour.id]);
    expect((await runInOrg(db, ORG_B, (tx) => listIngredientTypeLocks(tx, ORG_B))).size).toBe(0);
  });
});
