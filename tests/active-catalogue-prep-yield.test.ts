import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  ingredients,
  ingredientPrepActions,
  recipes,
  recipeIngredients,
} from '@/lib/db/schema';
import { loadActiveCatalogue } from '@/lib/data/active-catalogue';
import { recipeCost } from '@/lib/calculations/recipeCost';

/**
 * Prep-action yield must reach the catalogue-derived reports (CFO weekly,
 * daily-close, menu-engineering, profit-leaks) exactly as it reaches the recipe
 * cost card — they all read `CatalogueRecipeLine.prepYieldBps`. One catalogue
 * assertion + a report-style `recipeCost` recompute proves the wiring for all.
 */

const ORG = 'org_cat_prep';

let client: PGlite;
let db: TenantDb;
let recipeId: string;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;

  const [onion] = await db
    .insert(ingredients)
    .values({
      organizationId: ORG,
      name: 'Onion',
      dimension: 'weight',
      priceCents: 300,
    })
    .returning();
  const [prep] = await db
    .insert(ingredientPrepActions)
    .values({
      organizationId: ORG,
      ingredientId: onion!.id,
      name: 'diced',
      yieldBps: 8000,
    })
    .returning();
  const [recipe] = await db
    .insert(recipes)
    .values({
      organizationId: ORG,
      name: 'Onion Prep',
      yieldPortions: 1,
      yieldPercentage: 100,
      yieldWeightGrams: 200,
    })
    .returning();
  recipeId = recipe!.id;
  await db.insert(recipeIngredients).values({
    organizationId: ORG,
    recipeId,
    ingredientId: onion!.id,
    quantity: '200',
    prepActionId: prep!.id,
    displaySortOrder: 0,
  });
});

afterAll(async () => {
  await client.close();
});

it('catalogue lines carry prepYieldBps and reports cost the purchase loss', async () => {
  const catalogue = await runInOrg(db, ORG, (tx) => loadActiveCatalogue(tx, ORG));
  const recipe = catalogue.recipes.find((r) => r.id === recipeId)!;
  expect(recipe.lines[0]!.prepYieldBps).toBe(8000);

  // Recompute cost the way every catalogue report does.
  const cost = recipeCost({
    yieldPortions: recipe.yieldPortions,
    yieldPercentage: recipe.yieldPercentage,
    laborCostCents: recipe.laborCostCents,
    energyCostCents: recipe.energyCostCents,
    packagingCostCents: recipe.packagingCostCents,
    lines: recipe.lines.map((l) => ({
      dimension: l.dimension,
      priceCents: l.priceCents,
      quantity: l.quantity,
      prepYieldBps: l.prepYieldBps ?? undefined,
    })),
    componentMaterialCostsCents: [recipe.componentHiddenCostCents],
  });
  // 200 g edible @ 300c/kg = 60c; 80% yield → purchase 250 g → 75c.
  expect(cost.ingredientCostCents).toBe(75);
});
