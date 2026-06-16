import {
  withOrg,
  ingredients,
  recipes,
  recipeFolders,
  recipeIngredients,
  transactions,
} from '../lib/db';
import { recordMovement } from '../lib/data/inventory';
import {
  ensureCategoriesSeeded,
  listCategories,
} from '../lib/data/transaction-categories';

/**
 * DEV ONLY — fill ONE organization with a rich demo dataset so every module
 * (Recipes / Ingredients / Inventory / Financials / Break-even / Dashboard) has
 * plenty of data to exercise charts and calculations. Targets ≥10 rows in every
 * business table that can hold many rows.
 *
 *   SEED_ORG=org_xxx npm run seed:demo
 *   npm run seed:demo -- org_xxx
 *
 * Idempotent: clears this org's transactions, recipes (→ lines), ingredients
 * (→ movements) and folders, then reinserts. Categories are ensured (idempotent)
 * and org settings are left untouched.
 */

function loadEnv() {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // optional when DATABASE_URL is already in the environment
  }
}

const ORG = process.env.SEED_ORG ?? process.argv[2];

const pad2 = (n: number) => String(n).padStart(2, '0');

// ── Ingredients (12) — priceCents per canonical unit: per kg / per litre / per piece.
type SeedIngredient = {
  name: string;
  dimension: 'weight' | 'volume' | 'count';
  priceCents: number;
  /** Opening stock recorded as the first ledger movement (canonical unit). */
  opening: number;
  /** Optional usage recorded as a second (negative) ledger movement. */
  used?: number;
  lowStock?: number;
};

const INGREDIENTS: SeedIngredient[] = [
  { name: 'Wheat flour', dimension: 'weight', priceCents: 120, opening: 50000, used: 12000 },
  { name: 'Butter', dimension: 'weight', priceCents: 950, opening: 8000, used: 2500 },
  { name: 'Caster sugar', dimension: 'weight', priceCents: 110, opening: 25000, used: 4000 },
  { name: 'Dark chocolate 70%', dimension: 'weight', priceCents: 1800, opening: 6000, used: 1500 },
  { name: 'Eggs', dimension: 'count', priceCents: 35, opening: 240, used: 60 },
  { name: 'Whole milk', dimension: 'volume', priceCents: 150, opening: 20000, used: 3000 },
  { name: 'Olive oil', dimension: 'volume', priceCents: 900, opening: 5000, used: 800 },
  { name: 'Fine salt', dimension: 'weight', priceCents: 80, opening: 3000, used: 400, lowStock: 1000 },
  { name: 'Fresh yeast', dimension: 'weight', priceCents: 1600, opening: 1200, used: 600, lowStock: 1000 },
  { name: 'Vanilla extract', dimension: 'volume', priceCents: 12000, opening: 400, used: 120, lowStock: 200 },
  { name: 'Almond flour', dimension: 'weight', priceCents: 1400, opening: 4000, used: 900 },
  { name: 'Heavy cream', dimension: 'volume', priceCents: 380, opening: 6000, used: 1800 },
];

// ── Folders (4)
const FOLDERS = ['Breads', 'Viennoiserie', 'Desserts', 'Pastry'] as const;

// ── Recipes (10)
type SeedRecipe = {
  name: string;
  folder: (typeof FOLDERS)[number];
  yieldPortions: number;
  sellingPriceCents: number;
  laborCostCents?: number;
  energyCostCents?: number;
  packagingCostCents?: number;
  lines: { ingredient: string; quantity: number }[];
};

const RECIPES: SeedRecipe[] = [
  {
    name: 'Sourdough loaf', folder: 'Breads', yieldPortions: 4, sellingPriceCents: 450, energyCostCents: 60,
    lines: [
      { ingredient: 'Wheat flour', quantity: 1800 }, { ingredient: 'Fine salt', quantity: 36 },
      { ingredient: 'Fresh yeast', quantity: 18 }, { ingredient: 'Whole milk', quantity: 200 },
    ],
  },
  {
    name: 'Rosemary focaccia', folder: 'Breads', yieldPortions: 8, sellingPriceCents: 320, energyCostCents: 150,
    lines: [
      { ingredient: 'Wheat flour', quantity: 1000 }, { ingredient: 'Olive oil', quantity: 120 },
      { ingredient: 'Fine salt', quantity: 24 }, { ingredient: 'Fresh yeast', quantity: 16 },
    ],
  },
  {
    name: 'Brioche', folder: 'Breads', yieldPortions: 10, sellingPriceCents: 380, laborCostCents: 250, energyCostCents: 80,
    lines: [
      { ingredient: 'Wheat flour', quantity: 1000 }, { ingredient: 'Butter', quantity: 300 },
      { ingredient: 'Eggs', quantity: 5 }, { ingredient: 'Whole milk', quantity: 250 },
      { ingredient: 'Caster sugar', quantity: 120 }, { ingredient: 'Fresh yeast', quantity: 20 },
      { ingredient: 'Fine salt', quantity: 14 },
    ],
  },
  {
    name: 'Butter croissant', folder: 'Viennoiserie', yieldPortions: 12, sellingPriceCents: 250, laborCostCents: 200, packagingCostCents: 60,
    lines: [
      { ingredient: 'Wheat flour', quantity: 1000 }, { ingredient: 'Butter', quantity: 500 },
      { ingredient: 'Caster sugar', quantity: 100 }, { ingredient: 'Eggs', quantity: 2 },
      { ingredient: 'Fine salt', quantity: 12 }, { ingredient: 'Fresh yeast', quantity: 20 },
    ],
  },
  {
    name: 'Almond croissant', folder: 'Viennoiserie', yieldPortions: 12, sellingPriceCents: 350, laborCostCents: 300, packagingCostCents: 60,
    lines: [
      { ingredient: 'Wheat flour', quantity: 1000 }, { ingredient: 'Butter', quantity: 500 },
      { ingredient: 'Almond flour', quantity: 300 }, { ingredient: 'Caster sugar', quantity: 200 },
      { ingredient: 'Eggs', quantity: 3 }, { ingredient: 'Fresh yeast', quantity: 20 },
    ],
  },
  {
    name: 'Pain au chocolat', folder: 'Viennoiserie', yieldPortions: 12, sellingPriceCents: 300, laborCostCents: 250, packagingCostCents: 60,
    lines: [
      { ingredient: 'Wheat flour', quantity: 1000 }, { ingredient: 'Butter', quantity: 500 },
      { ingredient: 'Dark chocolate 70%', quantity: 360 }, { ingredient: 'Caster sugar', quantity: 100 },
      { ingredient: 'Fresh yeast', quantity: 20 }, { ingredient: 'Fine salt', quantity: 12 },
    ],
  },
  {
    name: 'Chocolate fondant', folder: 'Desserts', yieldPortions: 8, sellingPriceCents: 500, laborCostCents: 800, energyCostCents: 200, packagingCostCents: 120,
    lines: [
      { ingredient: 'Wheat flour', quantity: 200 }, { ingredient: 'Butter', quantity: 300 },
      { ingredient: 'Caster sugar', quantity: 250 }, { ingredient: 'Dark chocolate 70%', quantity: 350 },
      { ingredient: 'Eggs', quantity: 6 },
    ],
  },
  {
    name: 'Crème brûlée', folder: 'Desserts', yieldPortions: 6, sellingPriceCents: 480, laborCostCents: 400, energyCostCents: 150,
    lines: [
      { ingredient: 'Heavy cream', quantity: 500 }, { ingredient: 'Whole milk', quantity: 200 },
      { ingredient: 'Eggs', quantity: 6 }, { ingredient: 'Caster sugar', quantity: 150 },
      { ingredient: 'Vanilla extract', quantity: 10 },
    ],
  },
  {
    name: 'Vanilla custard tart', folder: 'Pastry', yieldPortions: 8, sellingPriceCents: 480, laborCostCents: 600, energyCostCents: 150,
    lines: [
      { ingredient: 'Wheat flour', quantity: 300 }, { ingredient: 'Butter', quantity: 200 },
      { ingredient: 'Caster sugar', quantity: 200 }, { ingredient: 'Whole milk', quantity: 500 },
      { ingredient: 'Eggs', quantity: 4 }, { ingredient: 'Vanilla extract', quantity: 10 },
    ],
  },
  {
    name: 'Chocolate chip cookies', folder: 'Pastry', yieldPortions: 24, sellingPriceCents: 150, laborCostCents: 150, packagingCostCents: 40,
    lines: [
      { ingredient: 'Wheat flour', quantity: 500 }, { ingredient: 'Butter', quantity: 250 },
      { ingredient: 'Caster sugar', quantity: 300 }, { ingredient: 'Dark chocolate 70%', quantity: 300 },
      { ingredient: 'Eggs', quantity: 2 },
    ],
  },
];

// ── Transactions — 12 months back from today, several per month, so monthly +
// annual dashboards, by-category breakdown and top-products are all rich.
type SeedTxn = {
  type: 'income' | 'expense';
  categorySlug: string;
  recipe?: string;
  occurredOn: string;
  amountCents: number;
  note?: string;
};

function buildSeedTransactions(): SeedTxn[] {
  const now = new Date();
  const out: SeedTxn[] = [];
  // Income recipes rotate so "top products" has a clear ranking.
  const incomeRecipes = ['Sourdough loaf', 'Butter croissant', 'Chocolate fondant', 'Almond croissant', 'Crème brûlée'];

  for (let back = 11; back >= 0; back--) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const ym = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
    // mild seasonal-ish variation
    const wobble = 1 + 0.18 * Math.sin((d.getMonth() / 12) * Math.PI * 2);

    // Income (4 entries): two recipe-linked food sales + catering + beverages.
    const r1 = incomeRecipes[back % incomeRecipes.length]!;
    const r2 = incomeRecipes[(back + 2) % incomeRecipes.length]!;
    out.push({ type: 'income', categorySlug: 'food_sales', recipe: r1, occurredOn: `${ym}-06`, amountCents: Math.round(52_000 * wobble) });
    out.push({ type: 'income', categorySlug: 'food_sales', recipe: r2, occurredOn: `${ym}-14`, amountCents: Math.round(38_000 * wobble) });
    out.push({ type: 'income', categorySlug: 'catering', occurredOn: `${ym}-19`, amountCents: Math.round(60_000 * wobble), note: 'Event order' });
    out.push({ type: 'income', categorySlug: 'beverage_sales', occurredOn: `${ym}-24`, amountCents: Math.round(18_000 * wobble) });

    // Expenses (4 entries): ingredients, rent (fixed), wages, utilities.
    out.push({ type: 'expense', categorySlug: 'ingredients', occurredOn: `${ym}-03`, amountCents: Math.round(42_000 * wobble) });
    out.push({ type: 'expense', categorySlug: 'rent', occurredOn: `${ym}-01`, amountCents: 120_000 });
    out.push({ type: 'expense', categorySlug: 'staff_wages', occurredOn: `${ym}-28`, amountCents: 88_000 });
    out.push({ type: 'expense', categorySlug: 'utilities', occurredOn: `${ym}-21`, amountCents: Math.round(15_000 * wobble) });
  }
  // A few one-off expenses for category variety.
  const thisYm = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
  out.push({ type: 'expense', categorySlug: 'equipment', occurredOn: `${thisYm}-10`, amountCents: 35_000, note: 'New mixer' });
  out.push({ type: 'expense', categorySlug: 'marketing', occurredOn: `${thisYm}-12`, amountCents: 12_000, note: 'Local ads' });
  out.push({ type: 'expense', categorySlug: 'packaging', occurredOn: `${thisYm}-08`, amountCents: 9_000 });
  return out;
}

async function main() {
  loadEnv();
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set (put it in .env.local or the environment).');
  }
  if (!ORG) {
    throw new Error('Set SEED_ORG=<clerk org id> (or pass it as the first argument).');
  }

  const txns = buildSeedTransactions();
  console.log(
    `▶ Seeding org ${ORG}: ${INGREDIENTS.length} ingredients, ${FOLDERS.length} folders, ${RECIPES.length} recipes, ${txns.length} transactions...`,
  );

  await withOrg(ORG, async (tx) => {
    // Clear in FK-safe order: transactions → recipes (cascades lines) →
    // ingredients (cascades movements) → folders.
    await tx.delete(transactions);
    await tx.delete(recipes);
    await tx.delete(ingredients);
    await tx.delete(recipeFolders);

    // Folders
    const folderRows = await tx
      .insert(recipeFolders)
      .values(FOLDERS.map((name, i) => ({ organizationId: ORG, name, sortOrder: i })))
      .returning();
    const folderIdByName = new Map(folderRows.map((f) => [f.name, f.id]));

    // Ingredients (stock starts at 0; opening balance comes from the ledger).
    const ingRows = await tx
      .insert(ingredients)
      .values(
        INGREDIENTS.map((i) => ({
          organizationId: ORG,
          name: i.name,
          dimension: i.dimension,
          priceCents: i.priceCents,
          stockQuantity: '0',
          lowStockThreshold: i.lowStock != null ? i.lowStock.toString() : null,
        })),
      )
      .returning();
    const ingIdByName = new Map(ingRows.map((i) => [i.name, i.id]));

    // Inventory movements: opening stock-in for every ingredient, plus a usage
    // stock-out where defined → a realistic ledger and correct running stock.
    let movementCount = 0;
    for (const i of INGREDIENTS) {
      const id = ingIdByName.get(i.name)!;
      await recordMovement(tx, ORG, { ingredientId: id, deltaCanonical: i.opening, note: 'Opening stock' });
      movementCount++;
      if (i.used) {
        await recordMovement(tx, ORG, { ingredientId: id, deltaCanonical: -i.used, note: 'Production usage' });
        movementCount++;
      }
    }

    // Recipes + lines
    const recipeIdByName = new Map<string, string>();
    for (const r of RECIPES) {
      const [recipe] = await tx
        .insert(recipes)
        .values({
          organizationId: ORG,
          name: r.name,
          folderId: folderIdByName.get(r.folder) ?? null,
          yieldPortions: r.yieldPortions,
          yieldPercentage: 100,
          laborCostCents: r.laborCostCents ?? 0,
          energyCostCents: r.energyCostCents ?? 0,
          packagingCostCents: r.packagingCostCents ?? 0,
          sellingPriceCents: r.sellingPriceCents,
        })
        .returning();
      if (!recipe) throw new Error(`seed: failed to insert recipe ${r.name}`);
      recipeIdByName.set(r.name, recipe.id);

      await tx.insert(recipeIngredients).values(
        r.lines.map((line, index) => {
          const ingredientId = ingIdByName.get(line.ingredient);
          if (!ingredientId) throw new Error(`seed: unknown ingredient ${line.ingredient}`);
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

    // Categories (idempotent) + transactions
    await ensureCategoriesSeeded(tx, ORG);
    const categoryIdBySlug = new Map(
      (await listCategories(tx, ORG)).map((c) => [c.slug, c.id]),
    );
    for (const t of txns) {
      const categoryId = categoryIdBySlug.get(t.categorySlug);
      if (!categoryId) throw new Error(`seed: unknown category ${t.categorySlug}`);
      await tx.insert(transactions).values({
        organizationId: ORG,
        type: t.type,
        categoryId,
        recipeId: t.recipe ? (recipeIdByName.get(t.recipe) ?? null) : null,
        occurredOn: t.occurredOn,
        amountCents: t.amountCents,
        note: t.note ?? null,
      });
    }

    const catCount = (await listCategories(tx, ORG)).length;
    console.log(
      `  ✓ ${FOLDERS.length} folders, ${INGREDIENTS.length} ingredients, ${movementCount} movements, ${RECIPES.length} recipes, ${catCount} categories, ${txns.length} transactions`,
    );
  });

  console.log(`✓ Seeded org ${ORG}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
