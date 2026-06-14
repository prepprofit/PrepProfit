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
 * Para que os dados apareçam no app, estes ids devem casar com os ids reais das
 * suas organizações no Clerk (visíveis no OrganizationSwitcher / dashboard do
 * Clerk). Sobrescreva via env SEED_ORG_A / SEED_ORG_B. Ver SETUP.md.
 */
const ORG_A = process.env.SEED_ORG_A ?? 'org_demo_a';
const ORG_B = process.env.SEED_ORG_B ?? 'org_demo_b';

type Seed = {
  ingredients: IngredientInput[];
  recipes: { name: string; yieldPortions: number }[];
};

const padaria: Seed = {
  ingredients: [
    { name: 'Farinha de trigo', unit: 'kg', priceType: 'per_kg', priceCents: 120 },
    { name: 'Fermento biológico', unit: 'kg', priceType: 'per_kg', priceCents: 1800 },
    { name: 'Sal', unit: 'kg', priceType: 'per_kg', priceCents: 90 },
  ],
  recipes: [{ name: 'Pão francês', yieldPortions: 50 }],
};

const confeitaria: Seed = {
  ingredients: [
    { name: 'Chocolate 70%', unit: 'kg', priceType: 'per_kg', priceCents: 4500 },
    { name: 'Manteiga', unit: 'kg', priceType: 'per_kg', priceCents: 3200 },
    { name: 'Framboesa', unit: 'kg', priceType: 'per_kg', priceCents: 6000 },
  ],
  recipes: [{ name: 'Mousse de framboesa', yieldPortions: 12 }],
};

async function seedOrg(organizationId: string, seed: Seed) {
  await withOrg(organizationId, async (tx) => {
    // idempotente: limpa dados anteriores desta org antes de semear
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
  await seedOrg(ORG_A, padaria);
  await seedOrg(ORG_B, confeitaria);
  console.log('✓ Seed complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
