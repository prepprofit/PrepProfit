import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { recipeIngredients, recipes } from '@/lib/db/schema';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe, getRecipeWithIngredients } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import { getRecipeWorkspace, saveRecipeWorkspace, type RecipeWorkspaceStructureDraft } from '@/lib/data/recipe-workspace';
import { loadRecipeFinishedWeights } from '@/lib/data/recipe-yield';
import { listRecipesForLibrary } from '@/lib/data/recipe-library';
import { buildRecipeDocument } from '@/lib/recipes/recipe-document';
import type { AuditActor } from '@/lib/data/audit';

/**
 * Recipe yield calculator + ingredient order (under `tenant_app`, RLS enforced):
 * finished weight = input × yield% or the measured weight (loss once); the chef's
 * order persists to every display; stored subtitles, notes and sections survive a
 * save that doesn't edit them; the 0053 backfill calculates weights honestly.
 */
const ORG = 'org_yield';
const OTHER = 'org_yield_other';
const actor: AuditActor = { userId: 'user_1', role: 'manager', requestId: 'req-yield' };

let client: PGlite;
let db: TenantDb;
let flourId: string;
let milkId: string;
let sugarId: string;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  await db.execute(sql.raw('SET ROLE tenant_app;'));
  await runInOrg(db, ORG, async (tx) => {
    flourId = (await createIngredient(tx, ORG, { name: 'Flour', dimension: 'weight', priceCents: 200 })).id;
    sugarId = (await createIngredient(tx, ORG, { name: 'Sugar', dimension: 'weight', priceCents: 100 })).id;
    milkId = (await createIngredient(tx, ORG, { name: 'Milk', dimension: 'volume', priceCents: 120 })).id;
  });
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

async function recipeWith(lines: { ingredientId: string; quantity: number }[], extra: Partial<Parameters<typeof createRecipe>[2]> = {}) {
  return runInOrg(db, ORG, async (tx) => {
    const r = await createRecipe(tx, ORG, { name: `R ${Math.random()}`, ...extra });
    for (const l of lines) await addRecipeIngredient(tx, ORG, { recipeId: r.id, ...l });
    return r.id;
  });
}

async function saveLines(recipeId: string, mutate: (draft: RecipeWorkspaceStructureDraft) => RecipeWorkspaceStructureDraft) {
  return runInOrg(db, ORG, async (tx) => {
    const dto = await getRecipeWorkspace(tx, ORG, recipeId, 'manager');
    if (!dto) throw new Error('no dto');
    const base: RecipeWorkspaceStructureDraft = {
      lines: [...dto.ingredientLines]
        .sort((a, b) => a.displaySortOrder - b.displaySortOrder)
        .map((l) => ({
          kind: 'ingredient' as const,
          id: l.id,
          ingredientId: l.ingredientId,
          quantity: l.quantity,
          prepActionId: l.prepActionId,
          enteredQuantity: l.enteredQuantity,
          enteredUnit: l.enteredUnit as never,
          note: l.note,
          sectionRef: l.sectionId,
        })),
      sections: dto.ingredientSections.map((s) => ({ id: s.id, title: s.title })),
    };
    return saveRecipeWorkspace(tx, ORG, recipeId, dto.recipe.version, mutate(base), actor);
  });
}

const row = async (id: string) => (await runInOrg(db, ORG, (tx) => tx.select().from(recipes).where(eq(recipes.id, id))))[0]!;

describe('yield calculator', () => {
  it('finished weight = input × yield% (calculated), and cost per kg uses it once', async () => {
    const id = await recipeWith([{ ingredientId: flourId, quantity: 1000 }]);
    const saved = await saveLines(id, (d) => ({ ...d, header: { yield: { percentage: 80, measuredGrams: null } } }));
    expect(saved.ok).toBe(true);
    const r = await row(id);
    expect(r).toMatchObject({ yieldPercentage: 80, yieldWeightGrams: 800, yieldWeightSource: 'calculated', yieldReviewNeeded: false });

    const lib = (await runInOrg(db, ORG, (tx) => listRecipesForLibrary(tx, ORG))).find((x) => x.id === id)!;
    // 1000 g flour @ €2/kg = 200c batch (not inflated by the yield) ÷ 0.8 kg = 250c/kg.
    expect(lib.money?.costPerPortionCents).toBe(200);
    expect(lib.money?.costPerKgCents).toBe(250);
  });

  it('a measured weight wins and stores the yield it implies', async () => {
    const id = await recipeWith([{ ingredientId: flourId, quantity: 1000 }]);
    await saveLines(id, (d) => ({ ...d, header: { yield: { percentage: 100, measuredGrams: 900 } } }));
    expect(await row(id)).toMatchObject({ yieldWeightGrams: 900, yieldWeightSource: 'measured', yieldPercentage: 90 });
  });

  it('never counts ml or pieces as grams: no calculated weight without a measured one', async () => {
    const id = await recipeWith([
      { ingredientId: flourId, quantity: 500 },
      { ingredientId: milkId, quantity: 300 },
    ]);
    await saveLines(id, (d) => ({ ...d, header: { yield: { percentage: 90, measuredGrams: null } } }));
    expect(await row(id)).toMatchObject({ yieldPercentage: 90, yieldWeightGrams: null, yieldWeightSource: null });
    const weights = await runInOrg(db, ORG, (tx) => loadRecipeFinishedWeights(tx, ORG, [{ id, yieldPercentage: 90, yieldWeightGrams: null }]));
    expect(weights.get(id)).toBeNull();
  });

  it('a calculated weight follows later quantity changes', async () => {
    const id = await recipeWith([{ ingredientId: flourId, quantity: 1000 }]);
    await saveLines(id, (d) => ({ ...d, header: { yield: { percentage: 50, measuredGrams: null } } }));
    await saveLines(id, (d) => ({ ...d, lines: d.lines!.map((l) => (l.kind === 'ingredient' ? { ...l, quantity: 2000 } : l)) }));
    expect((await row(id)).yieldWeightGrams).toBe(1000);
  });
});

describe('ingredient order', () => {
  it('persists a dragged order to the detail, document and kitchen calculator orderings', async () => {
    const id = await recipeWith([
      { ingredientId: flourId, quantity: 500 },
      { ingredientId: sugarId, quantity: 200 },
      { ingredientId: milkId, quantity: 100 },
    ]);
    // Move Milk to the top: Milk, Flour, Sugar.
    await saveLines(id, (d) => {
      const lines = [...d.lines!];
      const milk = lines.splice(2, 1)[0]!;
      lines.unshift(milk);
      return { ...d, lines };
    });

    const dto = (await runInOrg(db, ORG, (tx) => getRecipeWorkspace(tx, ORG, id, 'kitchen')))!;
    expect(buildRecipeDocument(dto, null).lines.map((l) => l.name)).toEqual(['Milk', 'Flour', 'Sugar']);
    const legacy = (await runInOrg(db, ORG, (tx) => getRecipeWithIngredients(tx, ORG, id)))!;
    expect(legacy.lines.map((l) => l.ingredient.name)).toEqual(['Milk', 'Flour', 'Sugar']);

    // The document is money-free for every role.
    expect(JSON.stringify(buildRecipeDocument(dto, null))).not.toMatch(/cents|price|cost|margin/i);
  });

  it('keeps stored subtitles and line notes that this screen no longer edits', async () => {
    const id = await recipeWith([{ ingredientId: flourId, quantity: 500 }]);
    await runInOrg(db, ORG, async (tx) => {
      await tx.update(recipes).set({ subtitle: 'Kept subtitle' }).where(eq(recipes.id, id));
      await tx.update(recipeIngredients).set({ note: 'sifted' }).where(eq(recipeIngredients.recipeId, id));
    });
    await saveLines(id, (d) => ({ ...d, header: { name: 'Renamed', yield: { percentage: 100, measuredGrams: null } } }));
    expect((await row(id)).subtitle).toBe('Kept subtitle');
    const lines = await runInOrg(db, ORG, (tx) => tx.select().from(recipeIngredients).where(eq(recipeIngredients.recipeId, id)));
    expect(lines[0]?.note).toBe('sifted');
  });

  it('another organisation cannot read or save the recipe', async () => {
    const id = await recipeWith([{ ingredientId: flourId, quantity: 500 }]);
    expect(await runInOrg(db, OTHER, (tx) => getRecipeWorkspace(tx, OTHER, id, 'manager'))).toBeNull();
    const result = await runInOrg(db, OTHER, (tx) => saveRecipeWorkspace(tx, OTHER, id, 1, { header: { name: 'x' } }, actor));
    expect(result.ok).toBe(false);
  });
});

describe('migration 0053 backfill', () => {
  it('flags old yields for review and calculates weights only for all-gram recipes', async () => {
    const grams = await recipeWith([{ ingredientId: flourId, quantity: 1000 }], { yieldPercentage: 90 });
    const mixed = await recipeWith([
      { ingredientId: flourId, quantity: 1000 },
      { ingredientId: milkId, quantity: 100 },
    ]);
    await runInOrg(db, ORG, (tx) =>
      tx.update(recipes).set({ yieldWeightGrams: null, yieldWeightSource: null, yieldReviewNeeded: false }).where(sql`${recipes.id} in (${grams}, ${mixed})`),
    );

    await db.execute(sql.raw('RESET ROLE;'));
    const file = readFileSync('drizzle/0053_recipe_yield_model.sql', 'utf8');
    for (const statement of file.split('--> statement-breakpoint').filter((s) => /^\s*(--.*\n)*\s*(UPDATE|WITH)/m.test(s) && !/ALTER TABLE/.test(s))) {
      await db.execute(sql.raw(statement));
    }
    await db.execute(sql.raw('SET ROLE tenant_app;'));

    expect(await row(grams)).toMatchObject({ yieldWeightGrams: 900, yieldWeightSource: 'calculated', yieldReviewNeeded: true });
    expect(await row(mixed)).toMatchObject({ yieldWeightGrams: null, yieldWeightSource: null, yieldReviewNeeded: false });
  });
});
