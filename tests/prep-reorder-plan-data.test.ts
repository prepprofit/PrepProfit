import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import { createMenu } from '@/lib/data/menus';
import {
  createTaskList,
  createPrepTaskFromRecipe,
  createTasksFromPrepPlan,
  getTaskListWithTasks,
} from '@/lib/data/tasks';
import { loadPrepReorderPlan } from '@/lib/data/prep-reorder-plan';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

/**
 * Prep/Reorder Planner data-layer tests (Sprint 7): the org-scoped demand resolution +
 * ledger read (loadPrepReorderPlan), and the bulk anchored-task creation with duplicate
 * prevention (createTasksFromPrepPlan). MONEY-FREE throughout.
 */

/** A weight ingredient with a set on-hand + optional low-stock threshold (canonical). */
async function stockedIngredient(
  db: TenantDb,
  org: string,
  name: string,
  onHand: number,
  threshold: number | null = null,
) {
  return createIngredient(db, org, {
    name,
    dimension: 'weight',
    priceCents: 1000,
    needsPricing: false,
    stockQuantity: String(onHand),
    lowStockThreshold: threshold == null ? null : String(threshold),
  });
}

describe('loadPrepReorderPlan', () => {
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

  it('scales explicit recipe demand and flags an insufficient-stock reorder', async () => {
    const flour = await stockedIngredient(db, ORG_A, 'Flour', 10_000);
    const recipe = await createRecipe(db, ORG_A, {
      name: 'Bread',
      yieldPortions: 10,
      yieldPercentage: 100,
    });
    const added = await addRecipeIngredient(db, ORG_A, {
      recipeId: recipe.id,
      ingredientId: flour.id,
      quantity: 5000, // 5 kg per 10-portion batch
    });
    if (!added.ok) throw new Error('failed to add line');

    // 30 portions → 3 batches → 15 kg needed vs 10 kg on hand → 5 kg short.
    const plan = await loadPrepReorderPlan(db, ORG_A, {
      recipes: [{ recipeId: recipe.id, portions: 30 }],
      menus: [],
    });
    expect(plan.prepSuggestions).toHaveLength(1);
    expect(plan.prepSuggestions[0]!.expectedPortions).toBe(30);
    expect(plan.reorderSuggestions).toEqual([
      expect.objectContaining({
        ingredientId: flour.id,
        requiredCanonical: 15_000,
        onHandCanonical: 10_000,
        shortfallCanonical: 5000,
      }),
    ]);
  });

  it('expands a menu selection into its component-recipe demand (quantity × covers)', async () => {
    const flour = await stockedIngredient(db, ORG_A, 'Flour', 0);
    const recipe = await createRecipe(db, ORG_A, {
      name: 'Roll',
      yieldPortions: 1,
      yieldPercentage: 100,
    });
    const added = await addRecipeIngredient(db, ORG_A, {
      recipeId: recipe.id,
      ingredientId: flour.id,
      quantity: 100, // 100 g per roll
    });
    if (!added.ok) throw new Error('failed to add line');
    const menu = await createMenu(
      db,
      ORG_A,
      { name: 'Basket', sellingPriceCents: 500, notes: null },
      [{ recipeId: recipe.id, quantity: 2 }], // 2 rolls per cover
    );
    if (menu.status !== 'ok') throw new Error('failed to create menu');

    // 5 covers × 2 rolls = 10 rolls → 1000 g flour; 0 on hand → reorder 1000 g.
    const plan = await loadPrepReorderPlan(db, ORG_A, {
      recipes: [],
      menus: [{ menuId: menu.menu.id, covers: 5 }],
    });
    expect(plan.prepSuggestions[0]!.expectedPortions).toBe(10);
    expect(plan.reorderSuggestions[0]!.shortfallCanonical).toBe(1000);
  });

  it('is org-scoped: another org\'s recipe selection resolves to nothing', async () => {
    const recipe = await createRecipe(db, ORG_B, {
      name: 'Foreign',
      yieldPortions: 1,
    });
    const plan = await loadPrepReorderPlan(db, ORG_A, {
      recipes: [{ recipeId: recipe.id, portions: 10 }],
      menus: [],
    });
    expect(plan.hasPlan).toBe(false);
    expect(plan.prepSuggestions).toHaveLength(0);
  });
});

describe('createTasksFromPrepPlan', () => {
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

  it('creates prep + reorder anchored tasks and skips duplicates/invalids', async () => {
    const flour = await stockedIngredient(db, ORG_A, 'Flour', 100);
    const recipe = await createRecipe(db, ORG_A, { name: 'Bread', yieldPortions: 1 });
    const list = await createTaskList(db, ORG_A, {
      name: 'Prep',
      notes: null,
      scheduledFor: null,
    });

    // Pre-seed a prep task for the recipe → the plan create must skip it as a duplicate.
    const seeded = await createPrepTaskFromRecipe(db, ORG_A, list.id, recipe.id);
    if (seeded.status !== 'ok') throw new Error('failed to seed prep task');

    const result = await createTasksFromPrepPlan(db, ORG_A, list.id, {
      prepRecipeIds: [recipe.id, recipe.id], // duplicate of the seeded + itself
      reorderIngredientIds: [flour.id, 'ing-missing'],
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.created).toHaveLength(1); // only the reorder task
    expect(result.created[0]!.sourceKind).toBe('reorder');
    expect(result.skippedDuplicate).toBe(1); // the recipe already anchored
    expect(result.skippedInvalid).toBe(1); // ing-missing

    const detail = await getTaskListWithTasks(db, ORG_A, list.id);
    expect(detail!.tasks).toHaveLength(2); // seeded prep + new reorder
    const reorder = detail!.tasks.find((t) => t.sourceKind === 'reorder');
    expect(reorder!.title).toBe('Flour');
    expect(reorder!.sourceIngredientId).toBe(flour.id);
  });

  it('skips a trashed recipe/ingredient as invalid', async () => {
    const list = await createTaskList(db, ORG_A, {
      name: 'Prep',
      notes: null,
      scheduledFor: null,
    });
    // A recipe id that does not exist in this org is invalid.
    const result = await createTasksFromPrepPlan(db, ORG_A, list.id, {
      prepRecipeIds: ['r-gone'],
      reorderIngredientIds: [],
    });
    if (result.status !== 'ok') throw new Error('unexpected status');
    expect(result.created).toHaveLength(0);
    expect(result.skippedInvalid).toBe(1);
  });

  it('returns not_found for a missing list', async () => {
    const result = await createTasksFromPrepPlan(db, ORG_A, 'no-list', {
      prepRecipeIds: [],
      reorderIngredientIds: [],
    });
    expect(result.status).toBe('not_found');
  });
});
