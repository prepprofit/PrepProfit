import {
  withOrg,
  ingredients,
  recipes,
  recipeIngredients,
  transactions,
} from '../lib/db';
import { eq, sql } from 'drizzle-orm';
import type { IngredientInput } from '../lib/data/ingredients';
import {
  ensureCategoriesSeeded,
  listCategories,
} from '../lib/data/transaction-categories';

/**
 * Seed ONE organization with a realistic demo catalogue (10 ingredients,
 * 5 priced recipes, ~12 transactions over two months), so you can exercise the
 * Recipes / Ingredients / Inventory / Financials / Dashboard modules with data
 * already in place.
 *
 * The org id is NOT hardcoded — pass your real Clerk organization id so the rows
 * are visible in the app (RLS scopes everything by org). Usage:
 *   SEED_ORG=org_xxx npm run seed:org
 *   npm run seed:org -- org_xxx
 *
 * Idempotent: it clears this org's recipes + ingredients first, then reinserts.
 * (For the two-org multi-tenancy isolation demo, use `npm run seed` instead.)
 */

function loadEnv() {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // optional when DATABASE_URL is already in the environment
  }
}

const ORG = process.env.SEED_ORG ?? process.argv[2];

/** Quantities are canonical: grams (weight), millilitres (volume), count. */
type SeedIngredient = IngredientInput & { stock?: number; lowStock?: number };

type SeedRecipe = {
  name: string;
  yieldPortions: number;
  yieldPercentage?: number;
  sellingPriceCents?: number;
  laborCostCents?: number;
  energyCostCents?: number;
  packagingCostCents?: number;
  lines: { ingredient: string; quantity: number }[];
};

// priceCents is per canonical purchase unit: per kg (weight), per litre (volume),
// or per piece (count).
const INGREDIENTS: SeedIngredient[] = [
  { name: 'Wheat flour', dimension: 'weight', priceCents: 120, stock: 50000 },
  { name: 'Butter', dimension: 'weight', priceCents: 950, stock: 8000 },
  { name: 'Caster sugar', dimension: 'weight', priceCents: 110, stock: 25000 },
  { name: 'Dark chocolate 70%', dimension: 'weight', priceCents: 1800, stock: 6000 },
  { name: 'Eggs', dimension: 'count', priceCents: 35, stock: 120 },
  { name: 'Whole milk', dimension: 'volume', priceCents: 150, stock: 20000 },
  { name: 'Olive oil', dimension: 'volume', priceCents: 900, stock: 5000 },
  { name: 'Fine salt', dimension: 'weight', priceCents: 80, stock: 3000, lowStock: 1000 },
  { name: 'Fresh yeast', dimension: 'weight', priceCents: 1600, stock: 800, lowStock: 1000 },
  { name: 'Vanilla extract', dimension: 'volume', priceCents: 12000, stock: 400, lowStock: 200 },
];

const RECIPES: SeedRecipe[] = [
  {
    name: 'Sourdough loaf',
    yieldPortions: 4,
    sellingPriceCents: 450,
    energyCostCents: 60,
    lines: [
      { ingredient: 'Wheat flour', quantity: 1800 },
      { ingredient: 'Fine salt', quantity: 36 },
      { ingredient: 'Fresh yeast', quantity: 18 },
      { ingredient: 'Whole milk', quantity: 200 },
    ],
  },
  {
    name: 'Butter croissant',
    yieldPortions: 12,
    sellingPriceCents: 250,
    laborCostCents: 200,
    packagingCostCents: 60,
    lines: [
      { ingredient: 'Wheat flour', quantity: 1000 },
      { ingredient: 'Butter', quantity: 500 },
      { ingredient: 'Caster sugar', quantity: 100 },
      { ingredient: 'Eggs', quantity: 2 },
      { ingredient: 'Fine salt', quantity: 12 },
      { ingredient: 'Fresh yeast', quantity: 20 },
    ],
  },
  {
    name: 'Chocolate fondant',
    yieldPortions: 8,
    sellingPriceCents: 500,
    laborCostCents: 800,
    energyCostCents: 200,
    packagingCostCents: 120,
    lines: [
      { ingredient: 'Wheat flour', quantity: 200 },
      { ingredient: 'Butter', quantity: 300 },
      { ingredient: 'Caster sugar', quantity: 250 },
      { ingredient: 'Dark chocolate 70%', quantity: 350 },
      { ingredient: 'Eggs', quantity: 6 },
    ],
  },
  {
    name: 'Vanilla custard tart',
    yieldPortions: 8,
    sellingPriceCents: 480,
    laborCostCents: 600,
    energyCostCents: 150,
    lines: [
      { ingredient: 'Wheat flour', quantity: 300 },
      { ingredient: 'Butter', quantity: 200 },
      { ingredient: 'Caster sugar', quantity: 200 },
      { ingredient: 'Whole milk', quantity: 500 },
      { ingredient: 'Eggs', quantity: 4 },
      { ingredient: 'Vanilla extract', quantity: 10 },
    ],
  },
  {
    name: 'Rosemary focaccia',
    yieldPortions: 8,
    sellingPriceCents: 320,
    energyCostCents: 150,
    lines: [
      { ingredient: 'Wheat flour', quantity: 1000 },
      { ingredient: 'Olive oil', quantity: 120 },
      { ingredient: 'Fine salt', quantity: 24 },
      { ingredient: 'Fresh yeast', quantity: 16 },
    ],
  },
];

type SeedTxn = {
  type: 'income' | 'expense';
  categorySlug: string;
  /** Recipe name to link (income only, powers top products), or undefined. */
  recipe?: string;
  occurredOn: string;
  amountCents: number;
  note?: string;
};

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * ~12 transactions across ≥3 categories and two months (this month + last),
 * with some income linked to seeded recipes. Months are computed from today so
 * the seeded data always lands in the current dashboard period.
 */
function buildSeedTransactions(): SeedTxn[] {
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonth = `${prevDate.getFullYear()}-${pad2(prevDate.getMonth() + 1)}`;

  return [
    // Previous month
    { type: 'income', categorySlug: 'food_sales', recipe: 'Sourdough loaf', occurredOn: `${prevMonth}-05`, amountCents: 45_000 },
    { type: 'income', categorySlug: 'food_sales', recipe: 'Butter croissant', occurredOn: `${prevMonth}-12`, amountCents: 30_000 },
    { type: 'income', categorySlug: 'catering', occurredOn: `${prevMonth}-18`, amountCents: 80_000, note: 'Wedding order' },
    { type: 'expense', categorySlug: 'ingredients', occurredOn: `${prevMonth}-03`, amountCents: 60_000 },
    { type: 'expense', categorySlug: 'rent', occurredOn: `${prevMonth}-01`, amountCents: 120_000 },
    { type: 'expense', categorySlug: 'utilities', occurredOn: `${prevMonth}-20`, amountCents: 18_000 },
    // This month
    { type: 'income', categorySlug: 'food_sales', recipe: 'Chocolate fondant', occurredOn: `${thisMonth}-04`, amountCents: 50_000 },
    { type: 'income', categorySlug: 'food_sales', recipe: 'Sourdough loaf', occurredOn: `${thisMonth}-09`, amountCents: 52_000 },
    { type: 'income', categorySlug: 'beverage_sales', occurredOn: `${thisMonth}-11`, amountCents: 22_000 },
    { type: 'expense', categorySlug: 'ingredients', occurredOn: `${thisMonth}-02`, amountCents: 55_000 },
    { type: 'expense', categorySlug: 'rent', occurredOn: `${thisMonth}-01`, amountCents: 120_000 },
    { type: 'expense', categorySlug: 'staff_wages', occurredOn: `${thisMonth}-15`, amountCents: 90_000 },
  ];
}

async function main() {
  loadEnv();
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env.local and fill it in (see SETUP.md).',
    );
  }
  if (!ORG) {
    throw new Error(
      'Set SEED_ORG=<clerk org id> (or pass it as the first argument). ' +
        'Find it in the OrganizationSwitcher / Clerk dashboard.',
    );
  }

  console.log(
    `▶ Seeding org ${ORG} with ${INGREDIENTS.length} ingredients, ${RECIPES.length} recipes, and ${buildSeedTransactions().length} transactions...`,
  );

  await withOrg(ORG, async (tx) => {
    const priorRecipes =
      (
        await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(recipes)
          .where(eq(recipes.organizationId, ORG))
      )[0]?.n ?? 0;
    const priorIngredients =
      (
        await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(ingredients)
          .where(eq(ingredients.organizationId, ORG))
      )[0]?.n ?? 0;
    console.log(
      `  • existing data for this org: ${priorIngredients} ingredients, ${priorRecipes} recipes (will be replaced)`,
    );

    // Idempotent: clear this org's data first. Transactions go first (they
    // reference recipes via an ON DELETE restrict FK); deleting recipes cascades
    // their lines; deleting ingredients cascades their inventory movements.
    await tx.delete(transactions).where(eq(transactions.organizationId, ORG));
    await tx.delete(recipes).where(eq(recipes.organizationId, ORG));
    await tx.delete(ingredients).where(eq(ingredients.organizationId, ORG));

    const inserted = await tx
      .insert(ingredients)
      .values(
        INGREDIENTS.map((i) => ({
          organizationId: ORG,
          name: i.name,
          dimension: i.dimension,
          priceCents: i.priceCents,
          supplier: i.supplier ?? null,
          stockQuantity: (i.stock ?? 0).toString(),
          lowStockThreshold: i.lowStock != null ? i.lowStock.toString() : null,
        })),
      )
      .returning();
    const idByName = new Map(inserted.map((i) => [i.name, i.id]));
    const recipeIdByName = new Map<string, string>();

    for (const r of RECIPES) {
      const [recipe] = await tx
        .insert(recipes)
        .values({
          organizationId: ORG,
          name: r.name,
          yieldPortions: r.yieldPortions,
          yieldPercentage: r.yieldPercentage ?? 100,
          laborCostCents: r.laborCostCents ?? 0,
          energyCostCents: r.energyCostCents ?? 0,
          packagingCostCents: r.packagingCostCents ?? 0,
          sellingPriceCents: r.sellingPriceCents ?? null,
        })
        .returning();
      if (!recipe) throw new Error(`seed: failed to insert recipe ${r.name}`);
      recipeIdByName.set(r.name, recipe.id);

      await tx.insert(recipeIngredients).values(
        r.lines.map((line, index) => {
          const ingredientId = idByName.get(line.ingredient);
          if (!ingredientId) {
            throw new Error(`seed: unknown ingredient ${line.ingredient}`);
          }
          return {
            organizationId: ORG,
            recipeId: recipe.id,
            ingredientId,
            quantity: line.quantity.toString(),
            sortOrder: index,
          };
        }),
      );
    }

    // Predefined categories + a couple of months of transactions so the finance
    // dashboards, CSV export, and break-even have real data to reconcile.
    await ensureCategoriesSeeded(tx, ORG);
    const categoryIdBySlug = new Map(
      (await listCategories(tx, ORG)).map((c) => [c.slug, c.id]),
    );

    for (const txn of buildSeedTransactions()) {
      const categoryId = categoryIdBySlug.get(txn.categorySlug);
      if (!categoryId) {
        throw new Error(`seed: unknown category ${txn.categorySlug}`);
      }
      await tx.insert(transactions).values({
        organizationId: ORG,
        type: txn.type,
        categoryId,
        recipeId: txn.recipe ? (recipeIdByName.get(txn.recipe) ?? null) : null,
        occurredOn: txn.occurredOn,
        amountCents: txn.amountCents,
        note: txn.note ?? null,
      });
    }
  });

  console.log(`✓ Seeded org ${ORG}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
