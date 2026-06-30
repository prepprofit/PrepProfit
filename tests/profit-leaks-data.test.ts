import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe, softDeleteRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import { createMenu } from '@/lib/data/menus';
import { loadProfitLeaks } from '@/lib/data/profit-leaks';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

/**
 * A `count`-dimension recipe with one line of `quantity` 1, so cost/portion ==
 * the ingredient `priceCents`. `sellingPriceCents` drives the margin findings.
 */
async function makeRecipe(
  db: TenantDb,
  org: string,
  opts: {
    name: string;
    sellingPriceCents: number | null;
    ingredientPriceCents?: number;
    needsPricing?: boolean;
    pendingPriceCents?: number | null;
  },
): Promise<{ recipeId: string; ingredientId: string }> {
  const ing = await createIngredient(db, org, {
    name: `${opts.name} ingredient`,
    dimension: 'count',
    priceCents: opts.ingredientPriceCents ?? 0,
    needsPricing: opts.needsPricing ?? false,
    pendingPriceCents: opts.pendingPriceCents ?? null,
  });
  const recipe = await createRecipe(db, org, {
    name: opts.name,
    sellingPriceCents: opts.sellingPriceCents,
  });
  const added = await addRecipeIngredient(db, org, {
    recipeId: recipe.id,
    ingredientId: ing.id,
    quantity: 1,
  });
  if (!added.ok) throw new Error('failed to add line');
  return { recipeId: recipe.id, ingredientId: ing.id };
}

describe('loadProfitLeaks data loader', () => {
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

  it('flags an active recipe below the target margin', async () => {
    // cost/portion 200, price 300 → margin 33.3% (< 65).
    const { recipeId } = await makeRecipe(db, ORG_A, {
      name: 'Thin margin',
      sellingPriceCents: 300,
      ingredientPriceCents: 200,
    });

    const findings = await loadProfitLeaks(db, ORG_A);
    const margin = findings.find((f) => f.type === 'RECIPE_BELOW_TARGET_MARGIN');
    expect(margin?.entityId).toBe(recipeId);
    expect(margin?.currentMarginPercent).toBe(33.3);
  });

  it('does not flag a healthy-margin recipe', async () => {
    // cost/portion 200, price 1000 → margin 80% (≥ 65).
    await makeRecipe(db, ORG_A, {
      name: 'Healthy',
      sellingPriceCents: 1000,
      ingredientPriceCents: 200,
    });
    expect(await loadProfitLeaks(db, ORG_A)).toEqual([]);
  });

  it('is org-scoped — org A never sees org B leaks', async () => {
    const { recipeId: bRecipe } = await makeRecipe(db, ORG_B, {
      name: 'B thin margin',
      sellingPriceCents: 300,
      ingredientPriceCents: 200,
    });

    const aFindings = await loadProfitLeaks(db, ORG_A);
    expect(aFindings).toEqual([]);

    const bFindings = await loadProfitLeaks(db, ORG_B);
    expect(bFindings.some((f) => f.entityId === bRecipe)).toBe(true);
  });

  it('excludes trashed recipes', async () => {
    const { recipeId } = await makeRecipe(db, ORG_A, {
      name: 'Doomed',
      sellingPriceCents: 300,
      ingredientPriceCents: 200,
    });
    expect((await loadProfitLeaks(db, ORG_A)).length).toBeGreaterThan(0);

    await softDeleteRecipe(db, ORG_A, recipeId);
    expect(await loadProfitLeaks(db, ORG_A)).toEqual([]);
  });

  it('surfaces an unpriced ingredient used in an active recipe', async () => {
    const { recipeId, ingredientId } = await makeRecipe(db, ORG_A, {
      name: 'Unpriced',
      sellingPriceCents: 300,
      ingredientPriceCents: 0,
      needsPricing: true,
    });

    const findings = await loadProfitLeaks(db, ORG_A);
    const unpriced = findings.find(
      (f) => f.type === 'UNPRICED_INGREDIENT_IN_ACTIVE_RECIPE',
    );
    expect(unpriced?.entityId).toBe(ingredientId);
    expect(unpriced?.affectedEntityIds).toEqual([recipeId]);
    // Margin is untrue when a line is unpriced → no margin finding for it.
    expect(findings.some((f) => f.type === 'RECIPE_BELOW_TARGET_MARGIN')).toBe(false);
  });

  it('surfaces a pending price observation affecting an active recipe', async () => {
    const { recipeId, ingredientId } = await makeRecipe(db, ORG_A, {
      name: 'Pending',
      sellingPriceCents: 1000, // healthy margin so the only finding is the pending one
      ingredientPriceCents: 200,
      pendingPriceCents: 350,
    });

    const findings = await loadProfitLeaks(db, ORG_A);
    const pending = findings.find((f) => f.type === 'PENDING_PRICE_CHANGE_IMPACT');
    expect(pending?.entityId).toBe(ingredientId);
    expect(pending?.currentCostCents).toBe(200);
    expect(pending?.pendingCostCents).toBe(350);
    expect(pending?.affectedEntityIds).toEqual([recipeId]);
  });

  it('flags a complete menu below the target margin', async () => {
    const { recipeId } = await makeRecipe(db, ORG_A, {
      name: 'Component',
      sellingPriceCents: null,
      ingredientPriceCents: 200,
    });
    const created = await createMenu(
      db,
      ORG_A,
      { name: 'Combo', sellingPriceCents: 250, notes: null },
      [{ recipeId, quantity: 1 }],
    );
    if (created.status !== 'ok') throw new Error('create menu failed');

    const findings = await loadProfitLeaks(db, ORG_A);
    const menuFinding = findings.find((f) => f.type === 'MENU_BELOW_TARGET_MARGIN');
    // component cost 200, menu price 250 → margin 20% (< 65).
    expect(menuFinding?.entityId).toBe(created.menu.id);
    expect(menuFinding?.currentCostCents).toBe(200);
  });
});
