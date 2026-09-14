import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  createIngredient,
  getIngredientById,
  listIngredients,
  listTrashedIngredients,
  restoreIngredient,
  trashIngredient,
} from '@/lib/data/ingredients';
import { createRecipe, softDeleteRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';

/**
 * Ingredient → Trash (soft delete) under the non-privileged `tenant_app` role: an
 * unused ingredient leaves the active list and stays gone, a used one is refused
 * with the recipes that use it named, restore brings it back, and another org can
 * neither trash nor see it.
 */
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

describe('trashing an ingredient', () => {
  it('moves an unused ingredient to Trash, keeps it there, and restores it', async () => {
    const id = await runInOrg(db, ORG_A, async (tx) => (await createIngredient(tx, ORG_A, { name: 'Test disposable', dimension: 'weight', priceCents: 100 })).id);

    const outcome = await runInOrg(db, ORG_A, (tx) => trashIngredient(tx, ORG_A, id));
    expect(outcome.status).toBe('done');
    const active = await runInOrg(db, ORG_A, (tx) => listIngredients(tx, ORG_A));
    expect(active.some((r) => r.id === id)).toBe(false);
    const trashed = await runInOrg(db, ORG_A, (tx) => listTrashedIngredients(tx, ORG_A));
    expect(trashed.some((r) => r.id === id)).toBe(true);
    // A second attempt (double click / stale list) is not found, never a fake success.
    expect((await runInOrg(db, ORG_A, (tx) => trashIngredient(tx, ORG_A, id))).status).toBe('not_found');

    const restored = await runInOrg(db, ORG_A, (tx) => restoreIngredient(tx, ORG_A, id));
    expect(restored?.deletedAt).toBeNull();
    expect((await runInOrg(db, ORG_A, (tx) => getIngredientById(tx, ORG_A, id)))?.priceCents).toBe(100);
  });

  it('refuses an ingredient used by an active recipe and names the recipe; trashed recipes do not block', async () => {
    const { id, recipeId } = await runInOrg(db, ORG_A, async (tx) => {
      const ing = await createIngredient(tx, ORG_A, { name: 'Butter', dimension: 'weight', priceCents: 900 });
      const recipe = await createRecipe(tx, ORG_A, { name: 'Croissant' });
      await addRecipeIngredient(tx, ORG_A, { recipeId: recipe.id, ingredientId: ing.id, quantity: 250 });
      return { id: ing.id, recipeId: recipe.id };
    });

    const blocked = await runInOrg(db, ORG_A, (tx) => trashIngredient(tx, ORG_A, id));
    expect(blocked).toMatchObject({
      status: 'in_use',
      usage: { recipeCount: 1, recipeNames: ['Croissant'], menuCount: 0, menuNames: [] },
    });
    expect((await runInOrg(db, ORG_A, (tx) => getIngredientById(tx, ORG_A, id)))?.deletedAt).toBeNull();

    // The recipe's line (history) stays intact; once the recipe is trashed the delete goes through.
    await runInOrg(db, ORG_A, (tx) => softDeleteRecipe(tx, ORG_A, recipeId));
    expect((await runInOrg(db, ORG_A, (tx) => trashIngredient(tx, ORG_A, id))).status).toBe('done');
  });

  it('cannot trash or restore another organisation’s ingredient', async () => {
    const id = await runInOrg(db, ORG_A, async (tx) => (await createIngredient(tx, ORG_A, { name: 'Private', dimension: 'count', priceCents: 10 })).id);
    expect((await runInOrg(db, ORG_B, (tx) => trashIngredient(tx, ORG_B, id))).status).toBe('not_found');
    await runInOrg(db, ORG_A, (tx) => trashIngredient(tx, ORG_A, id));
    expect(await runInOrg(db, ORG_B, (tx) => restoreIngredient(tx, ORG_B, id))).toBeNull();
    expect((await runInOrg(db, ORG_B, (tx) => listTrashedIngredients(tx, ORG_B))).length).toBe(0);
  });
});
