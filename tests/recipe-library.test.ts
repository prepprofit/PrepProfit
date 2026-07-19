import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import {
  ingredients,
  ingredientAllergens,
  ingredientNutritionProfiles,
  recipeIngredients,
  recipePortionOptions,
} from '@/lib/db/schema';
import {
  listRecipesForLibrary,
  toKitchenLibraryRow,
} from '@/lib/data/recipe-library';
import { createBook, addRecipesToBook } from '@/lib/data/recipe-books';
import { createRecipe } from '@/lib/data/recipes';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

let client: PGlite;
let db: TenantDb;
let pricedRecipeId: string;
let roughRecipeId: string;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;

  // Reviewed, priced, profiled ingredient with a milk allergen.
  const [flour] = await db
    .insert(ingredients)
    .values({
      organizationId: ORG_A,
      name: 'Flour',
      dimension: 'weight',
      priceCents: 200, // per kg
      allergensReviewedAt: new Date(),
      allergensReviewedBy: 'user_1',
    })
    .returning();
  await db.insert(ingredientAllergens).values({
    organizationId: ORG_A,
    ingredientId: flour!.id,
    allergen: 'cereals_gluten',
    presence: 'contains',
  });
  await db.insert(ingredientNutritionProfiles).values({
    organizationId: ORG_A,
    ingredientId: flour!.id,
    source: 'custom',
    caloriesKcal: 360,
  });

  // Unreviewed, unpriced, unprofiled ingredient.
  const [mystery] = await db
    .insert(ingredients)
    .values({
      organizationId: ORG_A,
      name: 'Mystery',
      dimension: 'weight',
      priceCents: 0,
      needsPricing: true,
    })
    .returning();

  // "Clean" recipe: flour only, in a book, priced via default portion option.
  const priced = await createRecipe(db, ORG_A, {
    name: 'Bread',
    yieldPortions: 10,
    yieldPercentage: 100,
    laborCostCents: 0,
    energyCostCents: 0,
    packagingCostCents: 0,
    sellingPriceCents: null,
  });
  pricedRecipeId = priced.id;
  await db.insert(recipeIngredients).values({
    organizationId: ORG_A,
    recipeId: priced.id,
    ingredientId: flour!.id,
    quantity: '1000', // 1 kg → 200c total → 20c/portion
  });
  await db.insert(recipePortionOptions).values({
    organizationId: ORG_A,
    recipeId: priced.id,
    name: 'Default serving',
    quantity: 1,
    unit: 'serving',
    sellingPriceCents: 100,
    isDefault: true,
  });
  const book = await createBook(db, ORG_A, 'Bakery');
  await addRecipesToBook(db, ORG_A, book.id, [priced.id]);

  // "Rough" recipe: unreviewed/unpriced/unprofiled ingredient, no book, no price.
  const rough = await createRecipe(db, ORG_A, {
    name: 'Rough',
    yieldPortions: 1,
    yieldPercentage: 100,
    laborCostCents: 0,
    energyCostCents: 0,
    packagingCostCents: 0,
    sellingPriceCents: null,
  });
  roughRecipeId = rough.id;
  await db.insert(recipeIngredients).values({
    organizationId: ORG_A,
    recipeId: rough.id,
    ingredientId: mystery!.id,
    quantity: '500',
  });

  // Cross-org noise that must never leak.
  await createRecipe(db, ORG_B, { name: 'Other org' });
});

afterAll(async () => {
  await client.close();
});

describe('listRecipesForLibrary', () => {
  it('returns org-scoped rows with books, allergens, status and money', async () => {
    const rows = await listRecipesForLibrary(db, ORG_A);
    expect(rows.map((r) => r.name)).toEqual(['Bread', 'Rough']);

    const bread = rows.find((r) => r.id === pricedRecipeId)!;
    expect(bread.bookIds).toHaveLength(1);
    expect(bread.allergens).toEqual([
      { allergen: 'cereals_gluten', presence: 'contains' },
    ]);
    expect(bread.status).toEqual({
      allergensUnreviewed: false,
      nutritionIncomplete: false,
      noBook: false,
    });
    // Dual-read: the default portion option price wins; cost from the line.
    expect(bread.money).toEqual({
      costPerPortionCents: 20,
      sellingPriceCents: 100,
      marginPercent: 80,
      needsPricing: false,
    });

    const rough = rows.find((r) => r.id === roughRecipeId)!;
    expect(rough.status).toEqual({
      allergensUnreviewed: true,
      nutritionIncomplete: true,
      noBook: true,
    });
    expect(rough.money).toMatchObject({
      sellingPriceCents: null,
      marginPercent: null,
      needsPricing: true,
    });
  });

  it('toKitchenLibraryRow strips the money KEY from the payload (not just the value)', async () => {
    const rows = await listRecipesForLibrary(db, ORG_A);
    for (const row of rows.map(toKitchenLibraryRow)) {
      expect('money' in row).toBe(false);
      // Deep scan: no financial key survives anywhere in the kitchen payload.
      const scan = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(scan);
        else if (value && typeof value === 'object') {
          for (const [key, v] of Object.entries(value)) {
            expect(key.toLowerCase()).not.toMatch(/cents|price|margin|cost/);
            scan(v);
          }
        }
      };
      scan(row);
    }
  });

  it('returns nothing for an org without recipes', async () => {
    expect(await listRecipesForLibrary(db, 'org_empty')).toEqual([]);
  });
});
