import { withOrg, ingredients, recipes } from '../lib/db';
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

type Seed = {
  ingredients: IngredientInput[];
  recipes: { name: string; yieldPortions: number }[];
};

// priceCents is per canonical purchase unit: per kg (weight), per litre (volume),
// or per piece (count). Each org gets all three dimensions for realistic demos.
const bakery: Seed = {
  ingredients: [
    { name: 'Wheat flour', dimension: 'weight', priceCents: 120 },
    { name: 'Fresh yeast', dimension: 'weight', priceCents: 1800 },
    { name: 'Salt', dimension: 'weight', priceCents: 90 },
    { name: 'Olive oil', dimension: 'volume', priceCents: 800 },
    { name: 'Eggs', dimension: 'count', priceCents: 30 },
  ],
  recipes: [{ name: 'French bread', yieldPortions: 50 }],
};

const patisserie: Seed = {
  ingredients: [
    { name: 'Dark chocolate 70%', dimension: 'weight', priceCents: 4500 },
    { name: 'Butter', dimension: 'weight', priceCents: 3200 },
    { name: 'Raspberry', dimension: 'weight', priceCents: 6000 },
    { name: 'Whole milk', dimension: 'volume', priceCents: 150 },
    { name: 'Eggs', dimension: 'count', priceCents: 35 },
  ],
  recipes: [{ name: 'Raspberry mousse', yieldPortions: 12 }],
};

async function seedOrg(organizationId: string, seed: Seed) {
  await withOrg(organizationId, async (tx) => {
    // idempotent: clear this org's previous data before seeding
    await tx.delete(recipes);
    await tx.delete(ingredients);

    await tx
      .insert(ingredients)
      .values(seed.ingredients.map((i) => ({ ...i, organizationId })));
    await tx
      .insert(recipes)
      .values(seed.recipes.map((r) => ({ ...r, organizationId })));
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
