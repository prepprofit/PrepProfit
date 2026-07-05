import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import {
  createRecipe,
  listKitchenScaleRecipes,
  softDeleteRecipe,
} from '@/lib/data/recipes';
import { createIngredient } from '@/lib/data/ingredients';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import { addRecipePreset } from '@/lib/data/recipe-presets';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

describe('kitchen scale listing (money-free operational DTO)', () => {
  let client: PGlite;
  let db: TenantDb;

  beforeEach(async () => {
    const test = await createTestDb();
    client = test.client;
    db = test.db as unknown as TenantDb;
  });

  afterEach(async () => {
    await client.close();
  });

  it('returns only active recipes of the org, with correct counts', async () => {
    const flour = await createIngredient(db, ORG_A, {
      name: 'Flour',
      dimension: 'weight',
      priceCents: 250,
    });
    const water = await createIngredient(db, ORG_A, {
      name: 'Water',
      dimension: 'volume',
      priceCents: 0,
    });

    const bread = await createRecipe(db, ORG_A, {
      name: 'Bread',
      yieldPortions: 4,
      yieldWeightGrams: 1200,
    });
    await addRecipeIngredient(db, ORG_A, {
      recipeId: bread.id,
      ingredientId: flour.id,
      quantity: 1000,
    });
    await addRecipeIngredient(db, ORG_A, {
      recipeId: bread.id,
      ingredientId: water.id,
      quantity: 700,
    });
    await addRecipePreset(db, ORG_A, bread.id, {
      name: 'Small loaf',
      targetWeightGrams: 500,
    });

    // A bare recipe (no lines, no presets, no yield weight) counts as zeros.
    await createRecipe(db, ORG_A, { name: 'Bare' });

    // Trashed + cross-org recipes must be absent.
    const trashed = await createRecipe(db, ORG_A, { name: 'Trashed' });
    await softDeleteRecipe(db, ORG_A, trashed.id);
    await createRecipe(db, ORG_B, { name: 'Other org' });

    const listing = await listKitchenScaleRecipes(db, ORG_A);
    expect(listing.map((r) => r.name)).toEqual(['Bare', 'Bread']);

    const breadItem = listing.find((r) => r.name === 'Bread')!;
    expect(breadItem).toEqual({
      id: bread.id,
      name: 'Bread',
      folderId: null,
      yieldPortions: 4,
      yieldWeightGrams: 1200,
      lineCount: 2,
      presetCount: 1,
    });

    const bareItem = listing.find((r) => r.name === 'Bare')!;
    expect(bareItem.yieldWeightGrams).toBeNull();
    expect(bareItem.lineCount).toBe(0);
    expect(bareItem.presetCount).toBe(0);
  });

  it('DTO keys are exactly operational — no money field ever appears', async () => {
    const recipe = await createRecipe(db, ORG_A, {
      name: 'Cake',
      laborCostCents: 500,
      energyCostCents: 100,
      packagingCostCents: 50,
      sellingPriceCents: 2000,
    });

    const [item] = await listKitchenScaleRecipes(db, ORG_A);
    expect(item!.id).toBe(recipe.id);
    expect(Object.keys(item!).sort()).toEqual([
      'folderId',
      'id',
      'lineCount',
      'name',
      'presetCount',
      'yieldPortions',
      'yieldWeightGrams',
    ]);
  });
});
