import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { ingredients, recipes, recipeIngredients } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  createIngredient,
  getIngredientById,
  listIngredients,
} from '@/lib/data/ingredients';
import { listRecipes } from '@/lib/data/recipes';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

let client: PGlite;
let db: TenantDb;
let ingredientAId: string;
let ingredientBId: string;
let recipeAId: string;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;

  // Seed as superuser (bypasses RLS) — distinct data per organization.
  const a = await createIngredient(db, ORG_A, {
    name: 'Flour A',
    unit: 'kg',
    priceType: 'per_kg',
    priceCents: 120,
  });
  ingredientAId = a.id;

  const b = await createIngredient(db, ORG_B, {
    name: 'Chocolate B',
    unit: 'kg',
    priceType: 'per_kg',
    priceCents: 950,
  });
  ingredientBId = b.id;

  const insertedRecipes = await db
    .insert(recipes)
    .values([
      { organizationId: ORG_A, name: 'Bread A' },
      { organizationId: ORG_B, name: 'Cake B' },
    ])
    .returning();
  const recipeA = insertedRecipes.find((r) => r.organizationId === ORG_A);
  if (!recipeA) throw new Error('seed: missing org A recipe');
  recipeAId = recipeA.id;
});

afterAll(async () => {
  await client.close();
});

describe('application layer — scoped by organization_id', () => {
  it('org A only sees its own ingredients', async () => {
    const rows = await listIngredients(db, ORG_A);
    expect(rows.map((r) => r.name)).toEqual(['Flour A']);
  });

  it('org B only sees its own ingredients', async () => {
    const rows = await listIngredients(db, ORG_B);
    expect(rows.map((r) => r.name)).toEqual(['Chocolate B']);
  });

  it('org A CANNOT fetch an org B ingredient by id', async () => {
    const stolen = await getIngredientById(db, ORG_A, ingredientBId);
    expect(stolen).toBeNull();
  });

  it('each org only sees its own recipes', async () => {
    const recipesA = await listRecipes(db, ORG_A);
    const recipesB = await listRecipes(db, ORG_B);
    expect(recipesA.map((r) => r.name)).toEqual(['Bread A']);
    expect(recipesB.map((r) => r.name)).toEqual(['Cake B']);
  });
});

describe('database layer — cross-org referential integrity', () => {
  it('allows a recipe_ingredient within one organization', async () => {
    const [row] = await db
      .insert(recipeIngredients)
      .values({
        organizationId: ORG_A,
        recipeId: recipeAId,
        ingredientId: ingredientAId,
      })
      .returning();
    expect(row?.organizationId).toBe(ORG_A);
  });

  it('rejects a recipe_ingredient that links across organizations', async () => {
    // An org A line pointing at org B's ingredient: the composite
    // (organization_id, ingredient_id) FK has no matching parent row, so the DB
    // itself rejects the cross-tenant link.
    await expect(
      db.insert(recipeIngredients).values({
        organizationId: ORG_A,
        recipeId: recipeAId,
        ingredientId: ingredientBId,
      }),
    ).rejects.toThrow();
  });
});

describe('database layer — Row-Level Security (second defense)', () => {
  // Assume the non-privileged role so the RLS policies are enforced.
  beforeAll(async () => {
    await db.execute(sql.raw('SET ROLE tenant_app;'));
  });
  afterAll(async () => {
    await db.execute(sql.raw('RESET ROLE;'));
  });

  it('with org A in context, an unfiltered SELECT only returns org A rows', async () => {
    const orgIds = await runInOrg(db, ORG_A, async (tx) => {
      const result = await tx
        .select({ organizationId: ingredients.organizationId })
        .from(ingredients);
      return result.map((r) => r.organizationId);
    });
    expect(orgIds.length).toBeGreaterThan(0);
    expect(orgIds.every((id) => id === ORG_A)).toBe(true);
  });

  it('with org B in context, an unfiltered SELECT only returns org B rows', async () => {
    const orgIds = await runInOrg(db, ORG_B, async (tx) => {
      const result = await tx
        .select({ organizationId: ingredients.organizationId })
        .from(ingredients);
      return result.map((r) => r.organizationId);
    });
    expect(orgIds.every((id) => id === ORG_B)).toBe(true);
    expect(orgIds).not.toContain(ORG_A);
  });

  it('without an organization context, RLS blocks everything (secure by default)', async () => {
    const rows = await db.select().from(ingredients);
    expect(rows).toHaveLength(0);
  });
});
