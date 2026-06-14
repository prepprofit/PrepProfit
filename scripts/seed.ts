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

const bakery: Seed = {
  ingredients: [
    { name: 'Wheat flour', unit: 'kg', priceType: 'per_kg', priceCents: 120 },
    { name: 'Fresh yeast', unit: 'kg', priceType: 'per_kg', priceCents: 1800 },
    { name: 'Salt', unit: 'kg', priceType: 'per_kg', priceCents: 90 },
  ],
  recipes: [{ name: 'French bread', yieldPortions: 50 }],
};

const patisserie: Seed = {
  ingredients: [
    { name: 'Dark chocolate 70%', unit: 'kg', priceType: 'per_kg', priceCents: 4500 },
    { name: 'Butter', unit: 'kg', priceType: 'per_kg', priceCents: 3200 },
    { name: 'Raspberry', unit: 'kg', priceType: 'per_kg', priceCents: 6000 },
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
