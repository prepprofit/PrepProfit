import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import {
  createIngredient,
  lockActiveIngredient,
  softDeleteIngredient,
} from '@/lib/data/ingredients';
import {
  createRecipe,
  getRecipeWithIngredients,
  softDeleteRecipe,
} from '@/lib/data/recipes';
import {
  addRecipeIngredient,
  removeRecipeIngredient,
  reorderRecipeIngredients,
  updateRecipeIngredient,
} from '@/lib/data/recipe-ingredients';

const ORG = 'org_ri';

let client: PGlite;
let db: TenantDb;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
});

afterAll(async () => {
  await client.close();
});

/**
 * The composite FKs keep recipe lines within one org, but they don't see
 * soft-delete state. These guard the invariant "an active recipe line references
 * only active rows" against a forged action.
 */
describe('addRecipeIngredient — active-row guards', () => {
  it('adds an active ingredient to an active recipe', async () => {
    const recipe = await createRecipe(db, ORG, { name: 'Loaf' });
    const ingredient = await createIngredient(db, ORG, {
      name: 'Flour',
      dimension: 'weight',
      priceCents: 100,
    });

    const result = await addRecipeIngredient(db, ORG, {
      recipeId: recipe.id,
      ingredientId: ingredient.id,
      quantity: 500,
    });
    expect(result.ok).toBe(true);
  });

  it('refuses to add a TRASHED ingredient to an active recipe', async () => {
    const recipe = await createRecipe(db, ORG, { name: 'Cake' });
    const ingredient = await createIngredient(db, ORG, {
      name: 'Sugar',
      dimension: 'weight',
      priceCents: 90,
    });
    await softDeleteIngredient(db, ORG, ingredient.id);

    const result = await addRecipeIngredient(db, ORG, {
      recipeId: recipe.id,
      ingredientId: ingredient.id,
      quantity: 200,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ingredient_trashed');
  });

  it('refuses to add an ingredient to a TRASHED recipe', async () => {
    const recipe = await createRecipe(db, ORG, { name: 'Tart' });
    const ingredient = await createIngredient(db, ORG, {
      name: 'Butter',
      dimension: 'weight',
      priceCents: 800,
    });
    await softDeleteRecipe(db, ORG, recipe.id);

    const result = await addRecipeIngredient(db, ORG, {
      recipeId: recipe.id,
      ingredientId: ingredient.id,
      quantity: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('recipe_not_active');
  });
});

/**
 * The trash/add flows serialize on a FOR UPDATE lock of the ingredient row so a
 * concurrent trash can't slip between the in-use check and the line insert. The
 * lock itself can't be exercised concurrently under single-connection PGlite, but
 * its row-selection (active row only, org-scoped) is what makes the serialization
 * point correct — so we pin that.
 */
/**
 * update/remove may only touch a line of an ACTIVE recipe in the same org and
 * matching the passed recipeId. A forged line id from a trashed (or different)
 * recipe must be a no-op — the action surfaces NOT_FOUND. (Sprint 3.1 hardening.)
 */
describe('updateRecipeIngredient / removeRecipeIngredient — active-parent guard', () => {
  async function seedLine(recipeName: string, ingredientName: string) {
    const recipe = await createRecipe(db, ORG, { name: recipeName });
    const ingredient = await createIngredient(db, ORG, {
      name: ingredientName,
      dimension: 'weight',
      priceCents: 100,
    });
    const added = await addRecipeIngredient(db, ORG, {
      recipeId: recipe.id,
      ingredientId: ingredient.id,
      quantity: 100,
    });
    if (!added.ok) throw new Error('seed: failed to add line');
    return { recipeId: recipe.id, lineId: added.row.id };
  }

  it('updates a line on an active recipe', async () => {
    const { recipeId, lineId } = await seedLine('Soup', 'Carrot');
    const row = await updateRecipeIngredient(db, ORG, recipeId, lineId, {
      quantity: 250,
    });
    expect(row).not.toBeNull();
    expect(Number(row?.quantity)).toBe(250);
  });

  it('removes a line on an active recipe', async () => {
    const { recipeId, lineId } = await seedLine('Stew', 'Potato');
    expect(await removeRecipeIngredient(db, ORG, recipeId, lineId)).toBe(true);
    // Second remove finds nothing.
    expect(await removeRecipeIngredient(db, ORG, recipeId, lineId)).toBe(false);
  });

  it('refuses to update/remove a line whose recipe is TRASHED (forged id → no-op)', async () => {
    const { recipeId, lineId } = await seedLine('Pie', 'Apple');
    await softDeleteRecipe(db, ORG, recipeId);

    expect(
      await updateRecipeIngredient(db, ORG, recipeId, lineId, { quantity: 5 }),
    ).toBeNull();
    expect(await removeRecipeIngredient(db, ORG, recipeId, lineId)).toBe(false);
  });

  it('refuses when the recipeId does not match the line (forged pairing)', async () => {
    const { lineId } = await seedLine('Bread', 'Wheat');
    const other = await createRecipe(db, ORG, { name: 'Other recipe' });

    expect(
      await updateRecipeIngredient(db, ORG, other.id, lineId, { quantity: 5 }),
    ).toBeNull();
    expect(await removeRecipeIngredient(db, ORG, other.id, lineId)).toBe(false);
  });
});

/**
 * Batch reorder: atomic renumber inside one transaction, gated by an EXACT-set
 * check against the locked current lines. A mismatch (foreign/partial/duplicate id,
 * or a concurrent add/remove) returns `stale` and writes NOTHING; a trashed parent
 * returns `not_found`. Both roles use the same path (no money is touched).
 */
describe('reorderRecipeIngredients', () => {
  async function seedThreeLines(recipeName: string) {
    const recipe = await createRecipe(db, ORG, { name: recipeName });
    const lineIds: string[] = [];
    for (const name of ['A', 'B', 'C']) {
      const ingredient = await createIngredient(db, ORG, {
        name: `${recipeName}-${name}`,
        dimension: 'weight',
        priceCents: 100,
      });
      const added = await addRecipeIngredient(db, ORG, {
        recipeId: recipe.id,
        ingredientId: ingredient.id,
        quantity: 100,
        sortOrder: lineIds.length,
      });
      if (!added.ok) throw new Error('seed: failed to add line');
      lineIds.push(added.row.id);
    }
    return { recipeId: recipe.id, lineIds };
  }

  async function currentOrder(recipeId: string): Promise<string[]> {
    const data = await getRecipeWithIngredients(db, ORG, recipeId);
    return (data?.lines ?? []).map((l) => l.id);
  }

  it('renumbers to an exact new order and the order survives a reload', async () => {
    const { recipeId, lineIds } = await seedThreeLines('Reorder ok');
    const [a, b, c] = lineIds;
    const reversed = [c!, b!, a!];

    const outcome = await reorderRecipeIngredients(db, ORG, recipeId, reversed);
    expect(outcome).toEqual({ status: 'ok', count: 3 });
    // getRecipeWithIngredients orders by sort_order, so the reload reflects the new order.
    expect(await currentOrder(recipeId)).toEqual(reversed);
  });

  it('returns stale (no writes) when a FOREIGN id is in the payload', async () => {
    const { recipeId, lineIds } = await seedThreeLines('Reorder foreign');
    const before = await currentOrder(recipeId);

    const outcome = await reorderRecipeIngredients(db, ORG, recipeId, [
      lineIds[0]!,
      lineIds[1]!,
      'line_does_not_exist',
    ]);
    expect(outcome).toEqual({ status: 'stale' });
    expect(await currentOrder(recipeId)).toEqual(before);
  });

  it('returns stale (no writes) for a PARTIAL id set', async () => {
    const { recipeId, lineIds } = await seedThreeLines('Reorder partial');
    const before = await currentOrder(recipeId);

    const outcome = await reorderRecipeIngredients(db, ORG, recipeId, [
      lineIds[0]!,
      lineIds[1]!,
    ]);
    expect(outcome).toEqual({ status: 'stale' });
    expect(await currentOrder(recipeId)).toEqual(before);
  });

  it('returns stale for a DUPLICATE id payload (defense in depth)', async () => {
    const { recipeId, lineIds } = await seedThreeLines('Reorder dup');
    const before = await currentOrder(recipeId);

    const outcome = await reorderRecipeIngredients(db, ORG, recipeId, [
      lineIds[0]!,
      lineIds[0]!,
      lineIds[1]!,
    ]);
    expect(outcome).toEqual({ status: 'stale' });
    expect(await currentOrder(recipeId)).toEqual(before);
  });

  it('returns not_found when the parent recipe is TRASHED', async () => {
    const { recipeId, lineIds } = await seedThreeLines('Reorder trashed');
    await softDeleteRecipe(db, ORG, recipeId);

    const outcome = await reorderRecipeIngredients(db, ORG, recipeId, [
      lineIds[2]!,
      lineIds[1]!,
      lineIds[0]!,
    ]);
    expect(outcome).toEqual({ status: 'not_found' });
  });
});

describe('lockActiveIngredient', () => {
  it('reports an active ingredient as lockable, a trashed or foreign one not', async () => {
    const ingredient = await createIngredient(db, ORG, {
      name: 'Yeast',
      dimension: 'weight',
      priceCents: 50,
    });
    expect(await lockActiveIngredient(db, ORG, ingredient.id)).toBe(true);
    expect(await lockActiveIngredient(db, 'org_other', ingredient.id)).toBe(false);

    await softDeleteIngredient(db, ORG, ingredient.id);
    expect(await lockActiveIngredient(db, ORG, ingredient.id)).toBe(false);
  });
});
