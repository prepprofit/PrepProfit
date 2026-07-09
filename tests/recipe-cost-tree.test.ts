import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe, softDeleteRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import { addRecipeComponent } from '@/lib/data/recipe-components';
import { resolveRecipeCostTree } from '@/lib/data/recipe-cost-tree';
import { loadActiveCatalogue } from '@/lib/data/active-catalogue';
import { recipeCost } from '@/lib/calculations/recipeCost';

const ORG = 'org_rct';

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

describe('resolveRecipeCostTree', () => {
  it('matches recipeCost exactly for a component-free recipe (regression)', async () => {
    const flour = await createIngredient(db, ORG, {
      name: 'Flour',
      dimension: 'weight',
      priceCents: 120,
    });
    const recipe = await createRecipe(db, ORG, {
      name: 'Plain bread',
      yieldPortions: 10,
      yieldPercentage: 80,
      laborCostCents: 300,
      energyCostCents: 100,
      packagingCostCents: 50,
    });
    await addRecipeIngredient(db, ORG, {
      recipeId: recipe.id,
      ingredientId: flour.id,
      quantity: 2000,
    });

    const resolutions = await resolveRecipeCostTree(db, ORG, [recipe.id]);
    const resolution = resolutions.get(recipe.id);
    expect(resolution?.complete).toBe(true);
    if (resolution?.complete) {
      expect(resolution.cost).toEqual(
        recipeCost({
          yieldPortions: 10,
          yieldPercentage: 80,
          laborCostCents: 300,
          energyCostCents: 100,
          packagingCostCents: 50,
          lines: [{ dimension: 'weight', priceCents: 120, quantity: 2000 }],
        }),
      );
      expect(resolution.componentMaterialCostsCents).toEqual([]);
    }
  });

  it('cascades a 2-level component cost with parent loss on the component slice', async () => {
    const milk = await createIngredient(db, ORG, {
      name: 'Milk',
      dimension: 'volume',
      priceCents: 200,
    });
    // Child batch: 1000 ml milk = 200 cents material, no loss/hidden, yields 500 g.
    const cream = await createRecipe(db, ORG, {
      name: 'Cream base',
      yieldPortions: 1,
      yieldPercentage: 100,
      laborCostCents: 0,
      energyCostCents: 0,
      packagingCostCents: 0,
      yieldWeightGrams: 500,
    });
    await addRecipeIngredient(db, ORG, {
      recipeId: cream.id,
      ingredientId: milk.id,
      quantity: 1000,
    });
    // Parent: 250 g of cream (= half the child batch = 100 cents), 80% yield, +100 labor.
    const cake = await createRecipe(db, ORG, {
      name: 'Cream cake',
      yieldPortions: 2,
      yieldPercentage: 80,
      laborCostCents: 100,
      energyCostCents: 0,
      packagingCostCents: 0,
    });
    const added = await addRecipeComponent(db, ORG, cake.id, {
      componentRecipeId: cream.id,
      quantityGrams: 250,
    });
    expect(added.ok).toBe(true);

    const resolutions = await resolveRecipeCostTree(db, ORG, [cake.id]);
    const resolution = resolutions.get(cake.id);
    expect(resolution?.complete).toBe(true);
    if (resolution?.complete) {
      // material = 100 / 0.8 = 125; total = 125 + 100 labor = 225; per portion 113.
      expect(resolution.cost.ingredientCostCents).toBe(125);
      expect(resolution.cost.totalCostCents).toBe(225);
      expect(resolution.cost.costPerPortionCents).toBe(113);
      expect(resolution.componentMaterialCostsCents).toEqual([100]);
      if (added.ok) {
        expect(resolution.componentLineCostsCents.get(added.row.id)).toBe(100);
      }
    }
  });

  it('is incomplete (never zero) for a trashed root or a trashed component', async () => {
    const child = await createRecipe(db, ORG, {
      name: 'Doomed child',
      yieldWeightGrams: 100,
    });
    const parent = await createRecipe(db, ORG, { name: 'Sad parent' });
    const added = await addRecipeComponent(db, ORG, parent.id, {
      componentRecipeId: child.id,
      quantityGrams: 50,
    });
    expect(added.ok).toBe(true);
    // Bypass the (slice-8) trash guard to simulate corrupted data.
    await softDeleteRecipe(db, ORG, child.id);

    const resolutions = await resolveRecipeCostTree(db, ORG, [parent.id, child.id]);
    expect(resolutions.get(parent.id)?.complete).toBe(false);
    expect(resolutions.get(parent.id)?.cost).toBeNull();
    expect(resolutions.get(child.id)?.complete).toBe(false);
  });
});

describe('loadActiveCatalogue — sub-recipe flattening', () => {
  it('flattens component subtrees into scaled raw lines + hidden constant', async () => {
    const ORG2 = 'org_rct_cat';
    const butter = await createIngredient(db, ORG2, {
      name: 'Butter',
      dimension: 'weight',
      priceCents: 800,
    });
    // Child: 500 g butter (=400c), 80% loss, 200c labor, yields 1000 g.
    const dough = await createRecipe(db, ORG2, {
      name: 'Dough',
      yieldPortions: 1,
      yieldPercentage: 80,
      laborCostCents: 200,
      energyCostCents: 0,
      packagingCostCents: 0,
      yieldWeightGrams: 1000,
    });
    await addRecipeIngredient(db, ORG2, {
      recipeId: dough.id,
      ingredientId: butter.id,
      quantity: 500,
    });
    // Parent uses 500 g of dough (half a batch), no direct lines, no loss.
    const pie = await createRecipe(db, ORG2, {
      name: 'Pie',
      yieldPortions: 1,
      yieldPercentage: 100,
      laborCostCents: 0,
      energyCostCents: 0,
      packagingCostCents: 0,
    });
    const added = await addRecipeComponent(db, ORG2, pie.id, {
      componentRecipeId: dough.id,
      quantityGrams: 500,
    });
    expect(added.ok).toBe(true);

    const catalogue = await loadActiveCatalogue(db, ORG2);
    const flatPie = catalogue.recipes.find((r) => r.id === pie.id);
    expect(flatPie).toBeDefined();
    expect(flatPie?.costUnresolved).toBe(false);
    // batchScale = 0.5; materialScale = 0.5/0.8 = 0.625 → butter 312.5 g.
    expect(flatPie?.lines).toEqual([
      {
        ingredientId: butter.id,
        dimension: 'weight',
        priceCents: 800,
        quantity: 312.5,
      },
    ]);
    // hidden = 0.5 × 200 = 100.
    expect(flatPie?.componentHiddenCostCents).toBe(100);

    // Flattened cost equals the resolver's cascade exactly.
    const viaCatalogue = recipeCost({
      yieldPortions: flatPie!.yieldPortions,
      yieldPercentage: flatPie!.yieldPercentage,
      laborCostCents: flatPie!.laborCostCents,
      energyCostCents: flatPie!.energyCostCents,
      packagingCostCents: flatPie!.packagingCostCents,
      lines: flatPie!.lines.map((l) => ({
        dimension: l.dimension,
        priceCents: l.priceCents,
        quantity: l.quantity,
      })),
      componentMaterialCostsCents: [flatPie!.componentHiddenCostCents],
    });
    const resolutions = await resolveRecipeCostTree(db, ORG2, [pie.id]);
    const resolution = resolutions.get(pie.id);
    expect(resolution?.complete).toBe(true);
    if (resolution?.complete) {
      expect(viaCatalogue.totalCostCents).toBe(resolution.cost.totalCostCents);
    }
    // dough child total = 400/0.8 + 200 = 700; pie = 700 × 0.5 = 350.
    expect(viaCatalogue.totalCostCents).toBe(350);
  });

  it('keeps component-free recipes byte-identical (regression)', async () => {
    const ORG3 = 'org_rct_reg';
    const salt = await createIngredient(db, ORG3, {
      name: 'Salt',
      dimension: 'weight',
      priceCents: 50,
    });
    const recipe = await createRecipe(db, ORG3, { name: 'Plain' });
    await addRecipeIngredient(db, ORG3, {
      recipeId: recipe.id,
      ingredientId: salt.id,
      quantity: 10,
    });
    const catalogue = await loadActiveCatalogue(db, ORG3);
    const flat = catalogue.recipes.find((r) => r.id === recipe.id);
    expect(flat?.lines).toEqual([
      { ingredientId: salt.id, dimension: 'weight', priceCents: 50, quantity: 10 },
    ]);
    expect(flat?.componentHiddenCostCents).toBe(0);
    expect(flat?.costUnresolved).toBe(false);
  });
});
