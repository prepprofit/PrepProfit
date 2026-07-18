import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  ingredientNutritionProfiles,
  ingredients,
  ingredientUomEquivalencies,
  recipeComponents,
  recipeIngredients,
  recipePortionOptions,
  recipes,
} from '@/lib/db/schema';
import { resolveRecipeNutritionTree } from '@/lib/data/recipe-nutrition-tree';

/**
 * Shared nutrition resolver (Fase 6): batch rollup with honest completeness —
 * weight lines direct, volume lines through equivalencies, sub-recipe scaling
 * by finished weight, serving from the nutrition portion option, and the
 * missing-profile / missing-equivalency / cycle contamination paths.
 */

const ORG = 'org_nut_tree';

let client: PGlite;
let db: TenantDb;

let flourId: string; // weight, full profile (10 kcal/100 g etc.)
let milkId: string; // volume, WITH weight equivalency + profile
let oilId: string; // volume, NO equivalency
let mysteryId: string; // weight, no profile

async function makeRecipe(
  name: string,
  fields: Partial<typeof recipes.$inferInsert> = {},
): Promise<string> {
  const [r] = await db
    .insert(recipes)
    .values({ organizationId: ORG, name, yieldPortions: 4, ...fields })
    .returning();
  return r!.id;
}

async function addLine(recipeId: string, ingredientId: string, quantity: number) {
  await db.insert(recipeIngredients).values({
    organizationId: ORG,
    recipeId,
    ingredientId,
    quantity: String(quantity),
  });
}

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;

  const ing = await db
    .insert(ingredients)
    .values([
      { organizationId: ORG, name: 'Flour', priceCents: 100 },
      { organizationId: ORG, name: 'Milk', dimension: 'volume', priceCents: 100 },
      { organizationId: ORG, name: 'Oil', dimension: 'volume', priceCents: 100 },
      { organizationId: ORG, name: 'Mystery', priceCents: 100 },
    ])
    .returning();
  flourId = ing[0]!.id;
  milkId = ing[1]!.id;
  oilId = ing[2]!.id;
  mysteryId = ing[3]!.id;

  // Milk: 1030 g = 1000 ml (density 1.03).
  await db.insert(ingredientUomEquivalencies).values({
    organizationId: ORG,
    ingredientId: milkId,
    weightGrams: 1030,
    volumeMl: 1000,
    source: 'manual',
  });

  // Profiles: flour 10 kcal/100 g; milk 61 kcal/100 g (sodium unknown).
  await db.insert(ingredientNutritionProfiles).values([
    {
      organizationId: ORG,
      ingredientId: flourId,
      source: 'custom',
      caloriesKcal: 10,
      sodiumMg: 2,
    },
    {
      organizationId: ORG,
      ingredientId: milkId,
      source: 'usda',
      fdcId: 111,
      sourceDescription: 'Milk, whole',
      caloriesKcal: 61,
    },
  ]);

  await db.execute(sql.raw('SET ROLE tenant_app;'));
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

describe('direct lines', () => {
  it('weight + equivalency-converted volume lines roll up; serving from portion option', async () => {
    await db.execute(sql.raw('RESET ROLE;'));
    const recipeId = await makeRecipe('Batter', { yieldWeightGrams: 1000 });
    await addLine(recipeId, flourId, 500); // 50 kcal, 10 mg sodium
    await addLine(recipeId, milkId, 200); // 200 ml → 206 g → 125.66 kcal, sodium unknown
    await db.insert(recipePortionOptions).values({
      organizationId: ORG,
      recipeId,
      name: 'Label serving',
      quantity: 100,
      unit: 'g',
      isNutritionServing: true,
    });
    await db.execute(sql.raw('SET ROLE tenant_app;'));

    const map = await runInOrg(db, ORG, (tx) =>
      resolveRecipeNutritionTree(tx, ORG, [recipeId]),
    );
    const res = map.get(recipeId)!;
    expect(res.result.status).toBe('complete');
    expect(res.result.totals.caloriesKcal).toBeCloseTo(50 + 206 * 0.61, 5);
    // Milk's unknown sodium poisons ONLY sodium.
    expect(res.result.totals.sodiumMg).toBeNull();
    expect(res.servingGrams).toBe(100);
    expect(res.result.perServing!.caloriesKcal).toBeCloseTo((50 + 206 * 0.61) / 10, 5);

    // Line views expose provenance for the §9.6 table.
    const milkLine = res.lines.find((l) => l.ingredientId === milkId)!;
    expect(milkLine.edibleWeightGrams).toBeCloseTo(206, 5);
    expect(milkLine.profile!.source).toBe('usda');
  });

  it('volume line without equivalency → NO_WEIGHT_EQUIVALENCY; no profile → NO_PROFILE', async () => {
    await db.execute(sql.raw('RESET ROLE;'));
    const recipeId = await makeRecipe('Dressing');
    await addLine(recipeId, oilId, 100);
    await addLine(recipeId, mysteryId, 50);
    await db.execute(sql.raw('SET ROLE tenant_app;'));

    const map = await runInOrg(db, ORG, (tx) =>
      resolveRecipeNutritionTree(tx, ORG, [recipeId]),
    );
    const res = map.get(recipeId)!;
    expect(res.result.status).toBe('incomplete');
    const reasons = res.result.issues.map((i) => [i.reason, i.refId]);
    expect(reasons).toContainEqual(['NO_WEIGHT_EQUIVALENCY', oilId]);
    expect(reasons).toContainEqual(['NO_PROFILE', mysteryId]);
    // No nutrition serving defined either.
    expect(res.result.issues.some((i) => i.reason === 'NO_NUTRITION_SERVING')).toBe(true);
  });
});

describe('sub-recipes', () => {
  it('scales the child batch by used/yield weight; child without serving does NOT contaminate', async () => {
    await db.execute(sql.raw('RESET ROLE;'));
    // Child: 1000 g batch of flour-only → 100 kcal total. NO nutrition serving.
    const childId = await makeRecipe('Sauce', { yieldWeightGrams: 1000 });
    await addLine(childId, flourId, 1000);
    // Parent uses 250 g of the child + nutrition serving of 1 serving (of 4).
    const parentId = await makeRecipe('Plate', {
      yieldWeightGrams: 500,
      nutritionServingQuantity: 1,
      nutritionServingUnit: 'serving',
    });
    await db.insert(recipeComponents).values({
      organizationId: ORG,
      recipeId: parentId,
      componentRecipeId: childId,
      quantityGrams: 250,
    });
    await db.execute(sql.raw('SET ROLE tenant_app;'));

    const map = await runInOrg(db, ORG, (tx) =>
      resolveRecipeNutritionTree(tx, ORG, [parentId]),
    );
    const res = map.get(parentId)!;
    expect(res.result.status).toBe('complete');
    expect(res.result.totals.caloriesKcal).toBeCloseTo(25, 5); // 100 * 250/1000
    // Legacy nutrition_serving_* fallback: 1 of 4 servings.
    expect(res.result.perServing!.caloriesKcal).toBeCloseTo(6.25, 5);
  });

  it('child missing yield weight → NO_WEIGHT_EQUIVALENCY on the component', async () => {
    await db.execute(sql.raw('RESET ROLE;'));
    const childId = await makeRecipe('Weightless');
    await addLine(childId, flourId, 100);
    const parentId = await makeRecipe('Parent');
    await db.insert(recipeComponents).values({
      organizationId: ORG,
      recipeId: parentId,
      componentRecipeId: childId,
      quantityGrams: 50,
    });
    await db.execute(sql.raw('SET ROLE tenant_app;'));

    const map = await runInOrg(db, ORG, (tx) =>
      resolveRecipeNutritionTree(tx, ORG, [parentId]),
    );
    const res = map.get(parentId)!;
    expect(res.result.status).toBe('incomplete');
    expect(res.result.issues).toContainEqual({
      reason: 'NO_WEIGHT_EQUIVALENCY',
      refId: childId,
      refName: 'Weightless',
    });
  });

  it('a component cycle contaminates instead of looping', async () => {
    await db.execute(sql.raw('RESET ROLE;'));
    const aId = await makeRecipe('Cycle A', { yieldWeightGrams: 100 });
    const bId = await makeRecipe('Cycle B', { yieldWeightGrams: 100 });
    await db.insert(recipeComponents).values([
      {
        organizationId: ORG,
        recipeId: aId,
        componentRecipeId: bId,
        quantityGrams: 10,
      },
      {
        organizationId: ORG,
        recipeId: bId,
        componentRecipeId: aId,
        quantityGrams: 10,
      },
    ]);
    await db.execute(sql.raw('SET ROLE tenant_app;'));

    const map = await runInOrg(db, ORG, (tx) =>
      resolveRecipeNutritionTree(tx, ORG, [aId]),
    );
    const res = map.get(aId)!;
    expect(res.result.status).toBe('incomplete');
    expect(
      res.result.issues.some((i) => i.reason === 'SUBRECIPE_INCOMPLETE'),
    ).toBe(true);
  });
});
