import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import {
  createIngredient,
  lockActiveIngredient,
  softDeleteIngredient,
} from '@/lib/data/ingredients';
import { createRecipe, softDeleteRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';

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
