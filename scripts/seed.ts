import { withOrg, ingredients, recipes, recipeIngredients } from '../lib/db';
import type { IngredientInput } from '../lib/data/ingredients';

function loadEnv() {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // optional
  }
}

/**
 * For the data to show up in the app, these ids must match your real Clerk
 * organization ids (visible in the OrganizationSwitcher / Clerk dashboard).
 * Override with env SEED_ORG_A / SEED_ORG_B. See SETUP.md.
 */
const ORG_A = process.env.SEED_ORG_A ?? 'org_demo_a';
const ORG_B = process.env.SEED_ORG_B ?? 'org_demo_b';

/** Quantities are canonical: grams (weight), millilitres (volume), count. */
type SeedIngredient = IngredientInput & {
  stock?: number;
  lowStock?: number;
};

type SeedRecipe = {
  name: string;
  yieldPortions: number;
  yieldPercentage?: number;
  sellingPriceCents?: number;
  lines: { ingredient: string; quantity: number }[];
};

type Seed = {
  ingredients: SeedIngredient[];
  recipes: SeedRecipe[];
};

// priceCents is per canonical purchase unit: per kg (weight), per litre (volume),
// or per piece (count). Each org gets all three dimensions for realistic demos.
const bakery: Seed = {
  ingredients: [
    { name: 'Wheat flour', dimension: 'weight', priceCents: 120, stock: 50000 },
    { name: 'Fresh yeast', dimension: 'weight', priceCents: 1800, stock: 3000 },
    { name: 'Salt', dimension: 'weight', priceCents: 90, stock: 500, lowStock: 1000 },
    { name: 'Olive oil', dimension: 'volume', priceCents: 800, stock: 5000 },
    { name: 'Eggs', dimension: 'count', priceCents: 30, stock: 60 },
  ],
  recipes: [
    {
      name: 'French bread',
      yieldPortions: 50,
      sellingPriceCents: 300,
      lines: [
        { ingredient: 'Wheat flour', quantity: 30000 },
        { ingredient: 'Fresh yeast', quantity: 600 },
        { ingredient: 'Salt', quantity: 600 },
        { ingredient: 'Olive oil', quantity: 300 },
        { ingredient: 'Eggs', quantity: 6 },
      ],
    },
  ],
};

const patisserie: Seed = {
  ingredients: [
    { name: 'Dark chocolate 70%', dimension: 'weight', priceCents: 4500, stock: 8000 },
    { name: 'Butter', dimension: 'weight', priceCents: 3200, stock: 6000 },
    { name: 'Raspberry', dimension: 'weight', priceCents: 6000, stock: 200, lowStock: 1000 },
    { name: 'Whole milk', dimension: 'volume', priceCents: 150, stock: 10000 },
    { name: 'Eggs', dimension: 'count', priceCents: 35, stock: 90 },
  ],
  recipes: [
    {
      name: 'Raspberry mousse',
      yieldPortions: 12,
      sellingPriceCents: 1500,
      lines: [
        { ingredient: 'Dark chocolate 70%', quantity: 400 },
        { ingredient: 'Butter', quantity: 200 },
        { ingredient: 'Raspberry', quantity: 500 },
        { ingredient: 'Whole milk', quantity: 500 },
        { ingredient: 'Eggs', quantity: 6 },
      ],
    },
  ],
};

async function seedOrg(organizationId: string, seed: Seed) {
  await withOrg(organizationId, async (tx) => {
    // Idempotent: clear this org's data first. Deleting recipes cascades their
    // lines; deleting ingredients cascades their inventory movements.
    await tx.delete(recipes);
    await tx.delete(ingredients);

    const insertedIngredients = await tx
      .insert(ingredients)
      .values(
        seed.ingredients.map((i) => ({
          name: i.name,
          dimension: i.dimension,
          priceCents: i.priceCents,
          supplier: i.supplier ?? null,
          organizationId,
          stockQuantity: (i.stock ?? 0).toString(),
          lowStockThreshold: i.lowStock != null ? i.lowStock.toString() : null,
        })),
      )
      .returning();
    const idByName = new Map(insertedIngredients.map((i) => [i.name, i.id]));

    for (const r of seed.recipes) {
      const [recipe] = await tx
        .insert(recipes)
        .values({
          organizationId,
          name: r.name,
          yieldPortions: r.yieldPortions,
          yieldPercentage: r.yieldPercentage ?? 100,
          sellingPriceCents: r.sellingPriceCents ?? null,
        })
        .returning();
      if (!recipe) throw new Error(`seed: failed to insert recipe ${r.name}`);

      await tx.insert(recipeIngredients).values(
        r.lines.map((line, index) => {
          const ingredientId = idByName.get(line.ingredient);
          if (!ingredientId) {
            throw new Error(`seed: unknown ingredient ${line.ingredient}`);
          }
          return {
            organizationId,
            recipeId: recipe.id,
            ingredientId,
            quantity: line.quantity.toString(),
            sortOrder: index,
          };
        }),
      );
    }
  });
  console.log(`  ✓ seeded org ${organizationId}`);
}

async function main() {
  loadEnv();
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env.local and fill it in (see SETUP.md).',
    );
  }
  console.log('▶ Seeding two organizations with isolated data...');
  await seedOrg(ORG_A, bakery);
  await seedOrg(ORG_B, patisserie);
  console.log('✓ Seed complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
