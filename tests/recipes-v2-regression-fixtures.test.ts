import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  ingredients,
  ingredientPrepActions,
  recipes,
  recipeIngredients,
  recipeComponents,
} from '@/lib/db/schema';
import { resolveRecipeCostTree } from '@/lib/data/recipe-cost-tree';
import { deriveScale, scaleLineQuantity } from '@/lib/calculations/recipeScale';

/**
 * Recipes 2.0 FROZEN regression fixtures (Meez-parity plan, Fase 0/§21 item 5).
 *
 * These values are the pre-workspace-v2 baseline for cost and scale over a
 * known recipe tree, INCLUDING lines already using the new v2 columns
 * (sections/notes/display order/duplicate ingredient). They must stay exactly
 * equal through every later slice (dual read, dual write, workspace UI). A
 * failure here means Recipes 2.0 changed money or physics — that is a release
 * blocker, not a snapshot to update casually.
 *
 * Fixture tree (org fx):
 *   Sauce (sub-recipe): 200 g tomato @ €2.40/kg → 48c; yield 100%,
 *     4 portions, yield weight 200 g, labor 20c.
 *   Pasta Dish (parent): 300 g pasta @ €1.80/kg (54c) + 120 g pasta dupe line
 *     (21.6c) + 150 g of Sauce output; yield 90%, 2 portions, labor 100c.
 */

const ORG = 'org_fx';

let client: PGlite;
let db: TenantDb;
let sauceId: string;
let dishId: string;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;

  const ing = await db
    .insert(ingredients)
    .values([
      { organizationId: ORG, name: 'Tomato', dimension: 'weight', priceCents: 240 },
      { organizationId: ORG, name: 'Pasta', dimension: 'weight', priceCents: 180 },
    ])
    .returning();
  const tomatoId = ing[0]!.id;
  const pastaId = ing[1]!.id;

  const rec = await db
    .insert(recipes)
    .values([
      {
        organizationId: ORG,
        name: 'Sauce',
        yieldPortions: 4,
        yieldPercentage: 100,
        yieldWeightGrams: 200,
        laborCostCents: 20,
      },
      {
        organizationId: ORG,
        name: 'Pasta Dish',
        yieldPortions: 2,
        yieldPercentage: 90,
        yieldWeightGrams: 550,
        laborCostCents: 100,
        sellingPriceCents: 1400,
      },
    ])
    .returning();
  sauceId = rec[0]!.id;
  dishId = rec[1]!.id;

  await db.insert(recipeIngredients).values([
    {
      organizationId: ORG,
      recipeId: sauceId,
      ingredientId: tomatoId,
      quantity: '200',
      displaySortOrder: 0,
    },
    {
      organizationId: ORG,
      recipeId: dishId,
      ingredientId: pastaId,
      quantity: '300',
      displaySortOrder: 0,
      note: 'cooked',
    },
    // Duplicate ingredient line — legal after the v2 unique drop; MUST cost
    // exactly like a single 420 g line would.
    {
      organizationId: ORG,
      recipeId: dishId,
      ingredientId: pastaId,
      quantity: '120',
      displaySortOrder: 2,
      note: 'for finishing',
    },
  ]);

  await db.insert(recipeComponents).values({
    organizationId: ORG,
    recipeId: dishId,
    componentRecipeId: sauceId,
    quantityGrams: 150,
    displaySortOrder: 1,
  });
});

afterAll(async () => {
  await client.close();
});

describe('frozen cost fixtures', () => {
  it('sub-recipe (Sauce) costs exactly the baseline', async () => {
    const res = await runInOrg(db, ORG, (tx) =>
      resolveRecipeCostTree(tx, ORG, [sauceId]),
    );
    const sauce = res.get(sauceId);
    if (!sauce?.complete) throw new Error('sauce resolution incomplete');
    // 200 g tomato @ 240c/kg = 48c; yield 100% → 48c; + labor 20c = 68c.
    expect(sauce.cost).toEqual({
      ingredientCostCents: 48,
      hiddenCostCents: 20,
      totalCostCents: 68,
      costPerPortionCents: 17,
    });
  });

  it('parent with duplicate line + component costs exactly the baseline', async () => {
    const res = await runInOrg(db, ORG, (tx) =>
      resolveRecipeCostTree(tx, ORG, [dishId]),
    );
    const dish = res.get(dishId);
    if (!dish?.complete) throw new Error('dish resolution incomplete');
    // Direct pasta: (300+120) g @ 180c/kg = 75.6c.
    // Sauce component: finished-output cost 68c (incl. its labor) for 200 g
    // → 150 g = 51c. Material 126.6c / 90% yield = 140.66…c → 141c;
    // + labor 100c = 241c; 120c/portion.
    expect(dish.cost).toEqual({
      ingredientCostCents: 141,
      hiddenCostCents: 100,
      totalCostCents: 241,
      costPerPortionCents: 120,
    });
    expect(dish.componentLineCostsCents.get([...dish.componentLineCostsCents.keys()][0]!)).toBe(51);
  });
});

describe('prep-yield cost (Fase 4 — NEW fixtures, additive)', () => {
  // A separate tree so the FROZEN fixtures above stay byte-for-byte identical:
  // a prep action must only change cost on the line that actually references it.
  let prepIngId: string;
  let prepActionId: string;
  let prepRecipeId: string;

  beforeAll(async () => {
    const [ing] = await db
      .insert(ingredients)
      .values({
        organizationId: ORG,
        name: 'Onion FX',
        dimension: 'weight',
        priceCents: 300,
      })
      .returning();
    prepIngId = ing!.id;
    const [prep] = await db
      .insert(ingredientPrepActions)
      .values({
        organizationId: ORG,
        ingredientId: prepIngId,
        name: 'diced',
        yieldBps: 8000,
      })
      .returning();
    prepActionId = prep!.id;

    const [rec] = await db
      .insert(recipes)
      .values({
        organizationId: ORG,
        name: 'Onion Prep',
        yieldPortions: 1,
        yieldPercentage: 100,
        yieldWeightGrams: 200,
      })
      .returning();
    prepRecipeId = rec!.id;
    await db.insert(recipeIngredients).values({
      organizationId: ORG,
      recipeId: prepRecipeId,
      ingredientId: prepIngId,
      quantity: '200',
      prepActionId,
      displaySortOrder: 0,
    });
  });

  it('inflates cost by the prep yield (required-purchase loss)', async () => {
    const res = await runInOrg(db, ORG, (tx) =>
      resolveRecipeCostTree(tx, ORG, [prepRecipeId]),
    );
    const r = res.get(prepRecipeId);
    if (!r?.complete) throw new Error('prep recipe resolution incomplete');
    // 200 g edible @ 300c/kg = 60c; purchase at 80% yield → 250 g → 75c.
    expect(r.cost.ingredientCostCents).toBe(75);
    expect(r.cost.totalCostCents).toBe(75);
  });

  it('a line WITHOUT a prep action still costs the un-adjusted amount', async () => {
    // Detach and re-check: proves prep yield only bites where referenced.
    await runInOrg(db, ORG, (tx) =>
      tx
        .update(recipeIngredients)
        .set({ prepActionId: null })
        .where(
          and(
            eq(recipeIngredients.organizationId, ORG),
            eq(recipeIngredients.recipeId, prepRecipeId),
          ),
        ),
    );
    const res = await runInOrg(db, ORG, (tx) =>
      resolveRecipeCostTree(tx, ORG, [prepRecipeId]),
    );
    const r = res.get(prepRecipeId);
    if (!r?.complete) throw new Error('resolution incomplete');
    expect(r.cost.ingredientCostCents).toBe(60);
  });
});

describe('frozen scale fixtures', () => {
  it('portion, anchor and yield-weight scaling stay exact', () => {
    const portions = deriveScale(2, { kind: 'portions', targetPortions: 6 });
    expect(portions).toEqual({ ok: true, factor: 3, scaledPortions: 6 });

    const anchor = deriveScale(2, {
      kind: 'anchor',
      anchorLineQuantity: 300,
      targetCanonical: 450,
    });
    if (!anchor.ok) throw new Error('anchor scale failed');
    expect(anchor.factor).toBe(1.5);

    const weight = deriveScale(2, {
      kind: 'yieldWeight',
      baseWeightGrams: 550,
      targetWeightGrams: 1100,
    });
    if (!weight.ok) throw new Error('yieldWeight scale failed');
    expect(weight.factor).toBe(2);

    // Scaled quantities round to the canonical 2-decimal storage domain.
    expect(scaleLineQuantity(300, 1.5)).toBe(450);
    expect(scaleLineQuantity(120, 1 / 3)).toBe(40);
    expect(scaleLineQuantity(0.05, 1 / 3)).toBe(0.02);
  });
});
