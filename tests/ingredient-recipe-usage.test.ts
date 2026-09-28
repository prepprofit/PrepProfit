import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { runInOrg } from '@/lib/db/tenant';
import type { TenantDb } from '@/lib/db/tenant';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe, softDeleteRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import { addRecipeComponent } from '@/lib/data/recipe-components';
import { createFolder } from '@/lib/data/recipe-folders';
import { loadIngredientRecipeUsage } from '@/lib/data/ingredient-recipe-usage';
import { recipeComponents } from '@/lib/db/schema';

/**
 * "Used in recipes" on the ingredient details view, under the non-privileged
 * `tenant_app` role: direct + nested (any depth) usage, each recipe once, folder
 * breadcrumbs, trashed recipes excluded, no cross-org leakage, safe on cyclic data.
 */
const ORG_A = 'org_usage_a';
const ORG_B = 'org_usage_b';

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

const inA = <T>(fn: (tx: Parameters<Parameters<typeof runInOrg>[2]>[0]) => Promise<T>) =>
  runInOrg(db, ORG_A, fn as never) as Promise<T>;

const usage = (ingredientId: string, org = ORG_A) =>
  runInOrg(db, org, (tx) => loadIngredientRecipeUsage(tx, org, ingredientId));

describe('loadIngredientRecipeUsage', () => {
  it('finds direct and nested usage once each, with via labels and folder paths', async () => {
    const ids = await inA(async (tx) => {
      const almond = await createIngredient(tx, ORG_A, { name: 'Almond flour', dimension: 'weight', priceCents: 100 });
      const pastry = await createFolder(tx, ORG_A, 'Pastry');
      const fillings = await createFolder(tx, ORG_A, 'Fillings', null, pastry.id);
      const filling = await createRecipe(tx, ORG_A, { name: 'Almond filling', yieldWeightGrams: 1000, folderId: fillings.id });
      const tart = await createRecipe(tx, ORG_A, { name: 'Tart', yieldWeightGrams: 800, folderId: pastry.id });
      const box = await createRecipe(tx, ORG_A, { name: 'Gift box', yieldWeightGrams: 2000 });
      const biscuit = await createRecipe(tx, ORG_A, { name: 'Biscuit', yieldWeightGrams: 300 });
      const unrelated = await createRecipe(tx, ORG_A, { name: 'Unrelated', yieldWeightGrams: 300 });
      // Direct: filling AND biscuit; tart has it directly AND via the filling (one entry, direct).
      await addRecipeIngredient(tx, ORG_A, { recipeId: filling.id, ingredientId: almond.id, quantity: 200 });
      await addRecipeIngredient(tx, ORG_A, { recipeId: biscuit.id, ingredientId: almond.id, quantity: 50 });
      await addRecipeIngredient(tx, ORG_A, { recipeId: tart.id, ingredientId: almond.id, quantity: 10 });
      expect((await addRecipeComponent(tx, ORG_A, tart.id, { componentRecipeId: filling.id, quantityGrams: 300 })).ok).toBe(true);
      // Box → tart (nested two deep) AND box → biscuit (two paths, still one entry).
      expect((await addRecipeComponent(tx, ORG_A, box.id, { componentRecipeId: tart.id, quantityGrams: 400 })).ok).toBe(true);
      expect((await addRecipeComponent(tx, ORG_A, box.id, { componentRecipeId: biscuit.id, quantityGrams: 100 })).ok).toBe(true);
      return { almond: almond.id, unrelated: unrelated.id };
    });

    const result = await usage(ids.almond);
    expect(result).not.toBeNull();
    expect(result!.count).toBe(4);
    expect(result!.recipes.map((r) => r.name)).toEqual(['Almond filling', 'Biscuit', 'Gift box', 'Tart']);
    const byName = Object.fromEntries(result!.recipes.map((r) => [r.name, r]));
    expect(byName['Almond filling']).toMatchObject({ via: [], folderPath: ['Pastry', 'Fillings'] });
    expect(byName['Tart']).toMatchObject({ via: [], folderPath: ['Pastry'] });
    expect(byName['Biscuit']?.via).toEqual([]);
    // Gift box reaches it through Biscuit and Tart (both immediate components on a path).
    expect(byName['Gift box']).toMatchObject({ via: ['Biscuit', 'Tart'], folderPath: [] });
    expect(new Set(result!.recipes.map((r) => r.id)).size).toBe(result!.count);
  });

  it('labels a purely indirect recipe as via its component, not direct', async () => {
    const almond = await inA(async (tx) => {
      const ing = await createIngredient(tx, ORG_A, { name: 'Praline', dimension: 'weight', priceCents: 1 });
      const filling = await createRecipe(tx, ORG_A, { name: 'Praline filling', yieldWeightGrams: 500 });
      const cake = await createRecipe(tx, ORG_A, { name: 'Praline cake', yieldWeightGrams: 900 });
      await addRecipeIngredient(tx, ORG_A, { recipeId: filling.id, ingredientId: ing.id, quantity: 100 });
      await addRecipeComponent(tx, ORG_A, cake.id, { componentRecipeId: filling.id, quantityGrams: 200 });
      return ing.id;
    });
    const result = await usage(almond);
    expect(result!.recipes.find((r) => r.name === 'Praline cake')!.via).toEqual(['Praline filling']);
    expect(result!.recipes.find((r) => r.name === 'Praline filling')!.via).toEqual([]);
  });

  it('returns an empty (not null) result for an unused ingredient and null for a missing one', async () => {
    const id = await inA(async (tx) => (await createIngredient(tx, ORG_A, { name: 'Lonely', dimension: 'weight', priceCents: 1 })).id);
    expect(await usage(id)).toEqual({ count: 0, recipes: [] });
    expect(await usage('does-not-exist')).toBeNull();
  });

  it('excludes trashed recipes and does not carry usage through a trashed intermediate', async () => {
    const id = await inA(async (tx) => {
      const ing = await createIngredient(tx, ORG_A, { name: 'Vanilla', dimension: 'weight', priceCents: 1 });
      const base = await createRecipe(tx, ORG_A, { name: 'Vanilla base', yieldWeightGrams: 500 });
      const mid = await createRecipe(tx, ORG_A, { name: 'Vanilla mid', yieldWeightGrams: 500 });
      const top = await createRecipe(tx, ORG_A, { name: 'Vanilla top', yieldWeightGrams: 500 });
      const gone = await createRecipe(tx, ORG_A, { name: 'Vanilla gone' });
      await addRecipeIngredient(tx, ORG_A, { recipeId: base.id, ingredientId: ing.id, quantity: 5 });
      await addRecipeIngredient(tx, ORG_A, { recipeId: gone.id, ingredientId: ing.id, quantity: 5 });
      await addRecipeComponent(tx, ORG_A, mid.id, { componentRecipeId: base.id, quantityGrams: 100 });
      await addRecipeComponent(tx, ORG_A, top.id, { componentRecipeId: mid.id, quantityGrams: 100 });
      await softDeleteRecipe(tx, ORG_A, gone.id);
      // Trash the middle link directly (bypassing the component guard) to prove the walk stops.
      await tx.execute(sql`UPDATE recipes SET deleted_at = now() WHERE id = ${mid.id}`);
      return ing.id;
    });
    const result = await usage(id);
    expect(result!.recipes.map((r) => r.name)).toEqual(['Vanilla base']);
    expect(result!.count).toBe(1);
  });

  it('is isolated per organization', async () => {
    const id = await inA(async (tx) => {
      const ing = await createIngredient(tx, ORG_A, { name: 'Secret sauce', dimension: 'weight', priceCents: 1 });
      const r = await createRecipe(tx, ORG_A, { name: 'Org A only' });
      await addRecipeIngredient(tx, ORG_A, { recipeId: r.id, ingredientId: ing.id, quantity: 1 });
      return ing.id;
    });
    expect((await usage(id))!.count).toBe(1);
    // Org B asking about org A's ingredient id: it is simply not theirs.
    expect(await usage(id, ORG_B)).toBeNull();
  });

  it('terminates on corrupt cyclic component data', async () => {
    const id = await inA(async (tx) => {
      const ing = await createIngredient(tx, ORG_A, { name: 'Cycle spice', dimension: 'weight', priceCents: 1 });
      const a = await createRecipe(tx, ORG_A, { name: 'Cycle A', yieldWeightGrams: 100 });
      const b = await createRecipe(tx, ORG_A, { name: 'Cycle B', yieldWeightGrams: 100 });
      await addRecipeIngredient(tx, ORG_A, { recipeId: a.id, ingredientId: ing.id, quantity: 1 });
      await addRecipeComponent(tx, ORG_A, b.id, { componentRecipeId: a.id, quantityGrams: 10 });
      // Force the back-edge A → B that the write path would refuse.
      await tx.insert(recipeComponents).values({ organizationId: ORG_A, recipeId: a.id, componentRecipeId: b.id, quantityGrams: 10 });
      return ing.id;
    });
    const result = await usage(id);
    expect(result!.recipes.map((r) => r.name)).toEqual(['Cycle A', 'Cycle B']);
  });
});
