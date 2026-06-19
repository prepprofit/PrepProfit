import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { runInOrg } from '@/lib/db/tenant';
import type { TenantDb } from '@/lib/db/tenant';
import { ingredients, recipeIngredients, recipes } from '@/lib/db/schema';
import {
  planRecipeImport,
  applyRecipeImport,
  buildResolvedChoices,
  type ResolvedChoice,
} from '@/lib/data/import';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe } from '@/lib/data/recipes';
import { parseCsv } from '@/lib/import/csv';
import { parseRecipes } from '@/lib/import/parse';
import { lineCostCents } from '@/lib/calculations/recipeCost';

const ORG_A = 'org_recipes_a';
const ORG_B = 'org_recipes_b';
const HEADER = 'recipe,yield_portions,yield_percentage,ingredient,quantity,unit';

let client: PGlite;
let db: TenantDb;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
});

afterAll(async () => {
  await client.close();
});

function plan(org: string, csv: string) {
  const parsed = parseRecipes(parseCsv(csv));
  if (!parsed.ok) throw new Error(parsed.error);
  return runInOrg(db, org, (tx) =>
    planRecipeImport(tx, org, parsed.recipes, parsed.issues),
  );
}

describe('planRecipeImport — resolution', () => {
  it('links an exact existing ingredient and stages new ones', async () => {
    await createIngredient(db, ORG_A, { name: 'Flour T55', dimension: 'weight', priceCents: 120 });

    const result = await plan(
      ORG_A,
      `${HEADER}\nBread,10,95,Flour T55,1000,g\nBread,,,Saffron,2,g`,
    );
    expect(result.payload.resolutions['flour t55']).toMatchObject({ kind: 'exact' });
    expect(result.payload.resolutions['saffron']).toMatchObject({ kind: 'new' });
    expect(result.counts).toMatchObject({ total: 1, importable: 1, skipped: 0 });
  });

  it('offers a fuzzy suggestion but never auto-links it', async () => {
    await createIngredient(db, ORG_A, { name: 'Tomato', dimension: 'weight', priceCents: 50 });
    const result = await plan(ORG_A, `${HEADER}\nSauce,1,100,Tomatoes,800,g`);
    const res = result.payload.resolutions['tomatoes'];
    expect(res?.kind).toBe('fuzzy');
    if (res?.kind === 'fuzzy') {
      expect(res.suggestions.some((s) => s.name === 'Tomato')).toBe(true);
    }
  });

  it('skips a recipe whose name already exists in the org (DUPLICATE_RECIPE)', async () => {
    await createRecipe(db, ORG_A, { name: 'Existing Cake', yieldPortions: 8, yieldPercentage: 100 });
    const result = await plan(ORG_A, `${HEADER}\nExisting Cake,8,100,Flour T55,500,g`);
    expect(result.counts).toMatchObject({ importable: 0, skipped: 1 });
    expect(result.issues.some((i) => i.code === 'DUPLICATE_RECIPE')).toBe(true);
  });

  it('drops an exact-linked line whose dimension conflicts (UNIT_MISMATCH)', async () => {
    await createIngredient(db, ORG_A, { name: 'Olive Oil', dimension: 'volume', priceCents: 800 });
    // Olive Oil is a volume ingredient but the line uses grams (weight).
    const result = await plan(ORG_A, `${HEADER}\nDressing,1,100,Olive Oil,50,g`);
    expect(result.issues.some((i) => i.code === 'UNIT_MISMATCH')).toBe(true);
    expect(result.payload.recipes[0]!.lines).toHaveLength(0);
  });

  it('resolves against the active org only (no cross-org link)', async () => {
    await createIngredient(db, ORG_B, { name: 'Secret Spice', dimension: 'weight', priceCents: 999 });
    // Org A planning must NOT see org B's ingredient → it stages as new.
    const result = await plan(ORG_A, `${HEADER}\nRub,1,100,Secret Spice,5,g`);
    expect(result.payload.resolutions['secret spice']).toMatchObject({ kind: 'new' });
  });
});

describe('buildResolvedChoices — D8 validation', () => {
  it('force-links exact, force-creates new, and rejects a forged link to a new name', () => {
    const resolutions = {
      flour: { kind: 'exact' as const, ingredientId: 'i_flour', ingredientName: 'Flour' },
      saffron: { kind: 'new' as const },
    };
    const ok = buildResolvedChoices(resolutions, []);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.choices.get('flour')).toEqual({ action: 'link', ingredientId: 'i_flour' });
      expect(ok.choices.get('saffron')).toEqual({ action: 'create' });
    }
    // A client tries to link the 'new' name to an arbitrary id → rejected.
    const forged = buildResolvedChoices(resolutions, [
      { name: 'saffron', action: 'link', ingredientId: 'i_evil' },
    ]);
    expect(forged.ok).toBe(false);
  });

  it('accepts a fuzzy link only to an offered suggestion id', () => {
    const resolutions = {
      tomatoes: {
        kind: 'fuzzy' as const,
        suggestions: [{ ingredientId: 'i_tomato', name: 'Tomato', score: 0.8 }],
      },
    };
    const good = buildResolvedChoices(resolutions, [
      { name: 'tomatoes', action: 'link', ingredientId: 'i_tomato' },
    ]);
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.choices.get('tomatoes')).toEqual({ action: 'link', ingredientId: 'i_tomato' });

    const forged = buildResolvedChoices(resolutions, [
      { name: 'tomatoes', action: 'link', ingredientId: 'i_other' },
    ]);
    expect(forged.ok).toBe(false);

    // Default (no choice) → create, never auto-link.
    const def = buildResolvedChoices(resolutions, []);
    expect(def.ok).toBe(true);
    if (def.ok) expect(def.choices.get('tomatoes')).toEqual({ action: 'create' });
  });
});

describe('applyRecipeImport — creation, dedupe, cost honesty', () => {
  it('creates new ingredients (priceCents 0, needs pricing), recipes, and lines', async () => {
    const result = await plan(
      ORG_B,
      `${HEADER}\nNew Loaf,5,100,Rye Flour,800,g\nNew Loaf,,,Water,500,ml`,
    );
    const choices = new Map<string, ResolvedChoice>([
      ['rye flour', { action: 'create' }],
      ['water', { action: 'create' }],
    ]);

    const created = await runInOrg(db, ORG_B, (tx) =>
      applyRecipeImport(tx, ORG_B, result.payload, choices),
    );
    expect(created).toBe(1);

    const rye = await db
      .select()
      .from(ingredients)
      .where(and(eq(ingredients.organizationId, ORG_B), eq(ingredients.name, 'Rye Flour')));
    expect(rye[0]).toMatchObject({ priceCents: 0, needsPricing: true, dimension: 'weight' });

    const loaf = await db
      .select()
      .from(recipes)
      .where(and(eq(recipes.organizationId, ORG_B), eq(recipes.name, 'New Loaf')));
    expect(loaf).toHaveLength(1);

    const lines = await db
      .select()
      .from(recipeIngredients)
      .where(eq(recipeIngredients.recipeId, loaf[0]!.id));
    expect(lines).toHaveLength(2);

    // Cost honesty: the new unpriced ingredient contributes 0 to the recipe cost.
    const ryeLine = lines.find((l) => l.ingredientId === rye[0]!.id)!;
    expect(
      lineCostCents({ dimension: 'weight', priceCents: rye[0]!.priceCents, quantity: Number(ryeLine.quantity) }),
    ).toBe(0);
    // Once priced, the same line costs > 0 (live calc, no stored cost).
    expect(
      lineCostCents({ dimension: 'weight', priceCents: 200, quantity: Number(ryeLine.quantity) }),
    ).toBeGreaterThan(0);
  });

  it('links to an existing ingredient and sums two source names onto one line', async () => {
    const tomato = await createIngredient(db, ORG_B, {
      name: 'Tomato',
      dimension: 'weight',
      priceCents: 40,
    });
    // Two lines, distinct raw names, both resolved to the SAME existing tomato id.
    const result = await plan(
      ORG_B,
      `${HEADER}\nGazpacho,2,100,Tomato,500,g\nGazpacho,,,Tomatoes,300,g`,
    );
    const choices = new Map<string, ResolvedChoice>([
      ['tomato', { action: 'link', ingredientId: tomato.id }],
      ['tomatoes', { action: 'link', ingredientId: tomato.id }],
    ]);
    await runInOrg(db, ORG_B, (tx) => applyRecipeImport(tx, ORG_B, result.payload, choices));

    const recipe = await db
      .select()
      .from(recipes)
      .where(and(eq(recipes.organizationId, ORG_B), eq(recipes.name, 'Gazpacho')));
    const lines = await db
      .select()
      .from(recipeIngredients)
      .where(eq(recipeIngredients.recipeId, recipe[0]!.id));
    // One line for the single ingredient id, quantity summed (500 + 300 = 800 g).
    expect(lines).toHaveLength(1);
    expect(Number(lines[0]!.quantity)).toBe(800);
  });
});
