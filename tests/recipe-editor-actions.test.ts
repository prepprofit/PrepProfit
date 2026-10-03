import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { runInOrg } from '@/lib/db/tenant';
import type { TenantDb, TenantTx } from '@/lib/db/tenant';
import {
  auditLog,
  ingredients,
  recipeComponents,
  recipeFolders,
  recipeIngredients,
  recipeMethodSections,
  recipePresets,
  recipeSteps,
  recipes,
} from '@/lib/db/schema';
import { listRecipePresets } from '@/lib/data/recipe-presets';
import { getRecipeWorkspace } from '@/lib/data/recipe-workspace';
import { buildKitchenScaleDocument } from '@/lib/kitchen-scale/prep-document';

/**
 * Recipe editor actions (`/recipes/new`, `/recipes/[id]/edit`) against a real PGlite
 * DB. The whole form saves in ONE transaction: a failure anywhere leaves NO recipe
 * behind (so cancelling/failing never creates an empty record), the folder, notes,
 * g/kg unit and kitchen presets land with the lines, and editing preserves what the
 * form doesn't show (sections, numbered steps, ml/piece lines, entered units).
 */
const h = vi.hoisted(() => ({
  db: null as unknown as TenantDb,
  withOrg: null as unknown as <T>(org: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>,
  manager: true,
  org: 'org_ed',
  user: 'user_ed',
  limitAllowed: true,
}));

vi.mock('@/lib/auth', () => ({
  isManager: vi.fn(async () => h.manager),
  getOrgId: vi.fn(async () => h.org),
  getUserId: vi.fn(async () => h.user),
  getUserRole: vi.fn(async () => (h.manager ? 'manager' : 'kitchen')),
}));

vi.mock('@/lib/db', () => ({
  getDb: () => h.db,
  withOrg: (org: string, fn: (tx: TenantTx) => unknown) => h.withOrg(org, fn as never),
}));

vi.mock('@/lib/entitlements', () => ({
  assertPlanLimit: vi.fn(async () => ({ allowed: h.limitAllowed, limit: 10, tier: 'starter' as const })),
}));

vi.mock('@/lib/analytics', () => ({ trackEvent: vi.fn(async () => {}) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { createRecipeFromEditorAction, saveRecipeEditorAction } from '@/app/(app)/recipes/editor-actions';

const ORG = 'org_ed';
const OTHER = 'org_ed_other';

let client: PGlite;
let flourId: string;
let milkId: string;
let eggsId: string;
let otherOrgIngredientId: string;
let folderId: string;
let otherOrgFolderId: string;
let starterId: string;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  h.db = test.db as unknown as TenantDb;
  h.withOrg = (org, fn) => runInOrg(h.db, org, fn);

  const rows = await h.db
    .insert(ingredients)
    .values([
      { organizationId: ORG, name: 'Flour', dimension: 'weight', priceCents: 120 },
      { organizationId: ORG, name: 'Milk', dimension: 'volume', priceCents: 90 },
      { organizationId: ORG, name: 'Eggs', dimension: 'count', priceCents: 30 },
      { organizationId: OTHER, name: 'Foreign flour', dimension: 'weight', priceCents: 100 },
    ])
    .returning();
  [flourId, milkId, eggsId, otherOrgIngredientId] = rows.map((r) => r.id) as [string, string, string, string];

  const folders = await h.db
    .insert(recipeFolders)
    .values([
      { organizationId: ORG, name: 'Cakes' },
      { organizationId: OTHER, name: 'Their folder' },
    ])
    .returning();
  [folderId, otherOrgFolderId] = folders.map((f) => f.id) as [string, string];

  const [starter] = await h.db
    .insert(recipes)
    .values({ organizationId: ORG, name: 'Starter', yieldPortions: 1, yieldWeightGrams: 400 })
    .returning();
  starterId = starter!.id;
});

afterAll(async () => {
  await client.close();
});

afterEach(() => {
  h.manager = true;
  h.org = ORG;
  h.limitAllowed = true;
  vi.clearAllMocks();
});

async function recipeCount(org = ORG) {
  const rows = await h.db
    .select({ id: recipes.id })
    .from(recipes)
    .where(and(eq(recipes.organizationId, org), isNull(recipes.deletedAt)));
  return rows.length;
}

function baseInput() {
  return {
    name: 'Lemon tart',
    folderId: null as string | null,
    displayUnit: 'g' as const,
    notes: '',
    yield: { percentage: 100, measuredGrams: null as number | null },
    lines: [] as unknown[],
    presets: [] as { id?: string; name: string; targetWeightGrams: number }[],
  };
}

describe('createRecipeFromEditorAction', () => {
  it('creates the whole recipe in one go: lines in order, notes, folder, unit and presets', async () => {
    const result = await createRecipeFromEditorAction({
      ...baseInput(),
      name: '  Lemon tart  ',
      folderId,
      displayUnit: 'kg',
      notes: '1. Blind bake the shell.\n2. Fill and set.\n',
      lines: [
        { kind: 'ingredient', ingredientId: flourId, quantity: 1500, enteredQuantity: null, enteredUnit: null, prepActionId: null, note: null, sectionRef: null },
        { kind: 'ingredient', ingredientId: milkId, quantity: 250, enteredQuantity: null, enteredUnit: null, prepActionId: null, note: null, sectionRef: null },
        { kind: 'component', componentRecipeId: starterId, quantityGrams: 200, note: null, sectionRef: null },
        { kind: 'ingredient', ingredientId: eggsId, quantity: 3, enteredQuantity: null, enteredUnit: null, prepActionId: null, note: null, sectionRef: null },
      ],
      presets: [
        { name: '18 cm cake', targetWeightGrams: 450 },
        { name: 'Individual portion', targetWeightGrams: 44.5 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const id = result.data.id;

    const [row] = await h.db.select().from(recipes).where(eq(recipes.id, id));
    expect(row).toMatchObject({
      name: 'Lemon tart',
      folderId,
      displayUnit: 'kg',
      notes: '1. Blind bake the shell.\n2. Fill and set.',
      version: 2,
      laborCostCents: 0,
      energyCostCents: 0,
      packagingCostCents: 0,
      sellingPriceCents: null,
    });

    const dto = await runInOrg(h.db, ORG, (tx) => getRecipeWorkspace(tx, ORG, id, 'kitchen'));
    const merged = [
      ...dto!.ingredientLines.map((l) => ({ order: l.displaySortOrder, name: l.ingredient.name, qty: l.quantity })),
      ...dto!.componentLines.map((l) => ({ order: l.displaySortOrder, name: l.componentRecipeName, qty: l.quantityGrams })),
    ].sort((a, b) => a.order - b.order);
    expect(merged.map((l) => [l.name, l.qty])).toEqual([
      ['Flour', 1500],
      ['Milk', 250],
      ['Starter', 200],
      ['Eggs', 3],
    ]);

    // The same presets Kitchen Scale loads, in order, decimal weight intact.
    const presets = await runInOrg(h.db, ORG, (tx) => listRecipePresets(tx, ORG, id));
    expect(presets.map((p) => [p.name, p.targetWeightGrams])).toEqual([
      ['18 cm cake', 450],
      ['Individual portion', 44.5],
    ]);
    // Kitchen Scale's document carries the method text.
    expect(buildKitchenScaleDocument(dto!).methodNotes).toBe('1. Blind bake the shell.\n2. Fill and set.');

    const audits = await h.db.select({ action: auditLog.action, metadata: auditLog.metadata }).from(auditLog).where(eq(auditLog.entityId, id));
    expect(audits.map((a) => a.action).sort()).toEqual(['recipe.workspaceSave', 'recipePreset.sync']);
    expect(JSON.stringify(audits)).not.toContain('Individual portion');
    expect(JSON.stringify(audits)).not.toContain('Blind bake');
  });

  it('computes the finished weight from weighed lines (yield %) without changing quantities', async () => {
    const result = await createRecipeFromEditorAction({
      ...baseInput(),
      name: 'Shortbread',
      yield: { percentage: 90, measuredGrams: null },
      lines: [
        { kind: 'ingredient', ingredientId: flourId, quantity: 1000, enteredQuantity: null, enteredUnit: null, prepActionId: null, note: null, sectionRef: null },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [row] = await h.db.select().from(recipes).where(eq(recipes.id, result.data.id));
    expect(row).toMatchObject({ yieldPercentage: 90, yieldWeightGrams: 900, yieldWeightSource: 'calculated' });
    const [line] = await h.db.select().from(recipeIngredients).where(eq(recipeIngredients.recipeId, result.data.id));
    expect(Number(line!.quantity)).toBe(1000);
  });

  it('saves a basic recipe with nothing but a name (no lines, notes or presets)', async () => {
    const result = await createRecipeFromEditorAction({ ...baseInput(), name: 'Just a name' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [row] = await h.db.select().from(recipes).where(eq(recipes.id, result.data.id));
    expect(row).toMatchObject({ name: 'Just a name', notes: null, folderId: null, displayUnit: 'g', yieldWeightGrams: null });
  });

  it('lets KITCHEN create, and a forged money field is ignored', async () => {
    h.manager = false;
    const result = await createRecipeFromEditorAction({ ...baseInput(), name: 'Kitchen soup', sellingPriceCents: 999, laborCostCents: 500 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [row] = await h.db.select().from(recipes).where(eq(recipes.id, result.data.id));
    expect(row).toMatchObject({ sellingPriceCents: null, laborCostCents: 0 });
  });

  it('leaves NO recipe behind when a line is invalid (another org’s ingredient)', async () => {
    const before = await recipeCount();
    const result = await createRecipeFromEditorAction({
      ...baseInput(),
      name: 'Should not exist',
      lines: [
        { kind: 'ingredient', ingredientId: otherOrgIngredientId, quantity: 10, enteredQuantity: null, enteredUnit: null, prepActionId: null, note: null, sectionRef: null },
      ],
    });
    expect(result).toEqual({ ok: false, code: 'WORKSPACE_DRAFT_INVALID' });
    expect(await recipeCount()).toBe(before);
  });

  it('leaves NO recipe behind when a preset can’t be saved (forged id)', async () => {
    const before = await recipeCount();
    const result = await createRecipeFromEditorAction({
      ...baseInput(),
      name: 'Should not exist either',
      presets: [{ id: 'not-a-real-preset', name: 'Tray', targetWeightGrams: 1000 }],
    });
    expect(result).toEqual({ ok: false, code: 'RECIPE_PRESETS_CHANGED' });
    expect(await recipeCount()).toBe(before);
  });

  it('rejects duplicate preset names (case-insensitive) before any write', async () => {
    const before = await recipeCount();
    const result = await createRecipeFromEditorAction({
      ...baseInput(),
      presets: [
        { name: 'Tray', targetWeightGrams: 1000 },
        { name: 'tray', targetWeightGrams: 500 },
      ],
    });
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' });
    expect(await recipeCount()).toBe(before);
  });

  it('refuses another organisation’s folder', async () => {
    const before = await recipeCount();
    const result = await createRecipeFromEditorAction({ ...baseInput(), folderId: otherOrgFolderId });
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await recipeCount()).toBe(before);
  });

  it('enforces the plan recipe cap with nothing created', async () => {
    h.limitAllowed = false;
    const before = await recipeCount();
    const result = await createRecipeFromEditorAction({ ...baseInput(), name: 'Over the cap' });
    expect(result).toEqual({ ok: false, code: 'PLAN_LIMIT_REACHED' });
    expect(await recipeCount()).toBe(before);
  });

  it('rejects a blank name, negative quantities and over-long notes', async () => {
    expect(await createRecipeFromEditorAction({ ...baseInput(), name: '   ' })).toEqual({ ok: false, code: 'INVALID_INPUT' });
    expect(
      await createRecipeFromEditorAction({
        ...baseInput(),
        lines: [{ kind: 'ingredient', ingredientId: flourId, quantity: -1, enteredQuantity: null, enteredUnit: null, prepActionId: null, note: null, sectionRef: null }],
      }),
    ).toEqual({ ok: false, code: 'INVALID_INPUT' });
    expect(await createRecipeFromEditorAction({ ...baseInput(), notes: 'x'.repeat(10_001) })).toEqual({ ok: false, code: 'INVALID_INPUT' });
    expect(await createRecipeFromEditorAction({ ...baseInput(), presets: [{ name: 'Tray', targetWeightGrams: Number.NaN }] })).toEqual({
      ok: false,
      code: 'INVALID_INPUT',
    });
  });
});

describe('saveRecipeEditorAction', () => {
  /** A recipe saved by an earlier editor: a section, numbered steps, a cup line, presets. */
  async function seedLegacyRecipe() {
    const [recipe] = await h.db
      .insert(recipes)
      .values({ organizationId: ORG, name: 'Brioche', yieldPortions: 1, notes: 'Old notes', version: 3 })
      .returning();
    const recipeId = recipe!.id;
    const [section] = await h.db
      .insert(recipeMethodSections)
      .values({ organizationId: ORG, recipeId, title: 'Dough', sortOrder: 0 })
      .returning();
    const steps = await h.db
      .insert(recipeSteps)
      .values([
        { organizationId: ORG, recipeId, instruction: 'Mix everything', sortOrder: 0, sectionId: section!.id },
        { organizationId: ORG, recipeId, instruction: 'Proof overnight', sortOrder: 1, sectionId: section!.id },
      ])
      .returning();
    const lines = await h.db
      .insert(recipeIngredients)
      .values([
        { organizationId: ORG, recipeId, ingredientId: flourId, quantity: '500', displaySortOrder: 0 },
        { organizationId: ORG, recipeId, ingredientId: milkId, quantity: '200', displaySortOrder: 1 },
        { organizationId: ORG, recipeId, ingredientId: eggsId, quantity: '4', displaySortOrder: 2 },
      ])
      .returning();
    const presets = await h.db
      .insert(recipePresets)
      .values([
        { organizationId: ORG, recipeId, name: 'Small', targetWeightGrams: 300, sortOrder: 0 },
        { organizationId: ORG, recipeId, name: 'Large', targetWeightGrams: 900, sortOrder: 1 },
        { organizationId: ORG, recipeId, name: 'Old', targetWeightGrams: 50, sortOrder: 2 },
      ])
      .returning();
    return { recipeId, sectionId: section!.id, steps, lines, presets };
  }

  const lineFor = (row: { id: string; ingredientId: string; quantity: string }, quantity?: number) => ({
    kind: 'ingredient' as const,
    id: row.id,
    ingredientId: row.ingredientId,
    quantity: quantity ?? Number(row.quantity),
    enteredQuantity: null,
    enteredUnit: null,
    prepActionId: null,
    note: null,
    sectionRef: null,
  });

  it('saves edits atomically and keeps what the form preserves', async () => {
    const seed = await seedLegacyRecipe();
    const [flour, milk, eggs] = seed.lines as [typeof seed.lines[0], typeof seed.lines[0], typeof seed.lines[0]];
    const [small, large, old] = seed.presets as [typeof seed.presets[0], typeof seed.presets[0], typeof seed.presets[0]];

    const result = await saveRecipeEditorAction({
      ...baseInput(),
      recipeId: seed.recipeId,
      expectedVersion: 3,
      name: 'Brioche loaf',
      folderId,
      displayUnit: 'kg',
      notes: 'Old notes\nBake at 180 °C.',
      // Reordered; flour edited; ml + pieces untouched.
      lines: [lineFor(eggs), lineFor(flour, 550), lineFor(milk)],
      sections: [],
      methodSections: [{ id: seed.sectionId, title: 'Dough' }],
      steps: seed.steps.map((s) => ({ id: s.id, instruction: s.instruction, sectionRef: seed.sectionId, mediaIds: [] })),
      coverMediaId: null,
      // Swap the two names (unique index!), drop "Old", add a decimal one.
      presets: [
        { id: small.id, name: 'Large', targetWeightGrams: 300 },
        { id: large.id, name: 'Small', targetWeightGrams: 900 },
        { name: 'Portion', targetWeightGrams: 44.5 },
      ],
    });
    expect(result).toEqual({ ok: true, data: { version: 4 } });

    const [row] = await h.db.select().from(recipes).where(eq(recipes.id, seed.recipeId));
    expect(row).toMatchObject({ name: 'Brioche loaf', folderId, displayUnit: 'kg', notes: 'Old notes\nBake at 180 °C.', version: 4 });

    const lines = await h.db
      .select({ id: recipeIngredients.id, quantity: recipeIngredients.quantity, order: recipeIngredients.displaySortOrder })
      .from(recipeIngredients)
      .where(eq(recipeIngredients.recipeId, seed.recipeId))
      .orderBy(asc(recipeIngredients.displaySortOrder));
    expect(lines.map((l) => [l.id, Number(l.quantity)])).toEqual([
      [eggs.id, 4],
      [flour.id, 550],
      [milk.id, 200],
    ]);

    const steps = await h.db.select().from(recipeSteps).where(eq(recipeSteps.recipeId, seed.recipeId)).orderBy(asc(recipeSteps.sortOrder));
    expect(steps.map((s) => [s.instruction, s.sectionId])).toEqual([
      ['Mix everything', seed.sectionId],
      ['Proof overnight', seed.sectionId],
    ]);

    const presets = await runInOrg(h.db, ORG, (tx) => listRecipePresets(tx, ORG, seed.recipeId));
    expect(presets.map((p) => [p.id, p.name, p.targetWeightGrams])).toEqual([
      [small.id, 'Large', 300],
      [large.id, 'Small', 900],
      [expect.any(String), 'Portion', 44.5],
    ]);
    expect(presets.some((p) => p.id === old.id)).toBe(false);
  });

  it('a measured finished weight never changes ingredient quantities', async () => {
    const seed = await seedLegacyRecipe();
    const flourOnly = [lineFor(seed.lines[0]!)];
    const result = await saveRecipeEditorAction({
      ...baseInput(),
      recipeId: seed.recipeId,
      expectedVersion: 3,
      name: 'Brioche',
      yield: { percentage: 100, measuredGrams: 430.5 },
      lines: flourOnly,
      sections: [],
      methodSections: [],
      steps: [],
      coverMediaId: null,
      presets: [],
    });
    expect(result.ok).toBe(true);
    const [row] = await h.db.select().from(recipes).where(eq(recipes.id, seed.recipeId));
    expect(row).toMatchObject({ yieldWeightGrams: 430.5, yieldWeightSource: 'measured', yieldPercentage: 86 });
    const [line] = await h.db.select().from(recipeIngredients).where(eq(recipeIngredients.recipeId, seed.recipeId));
    expect(Number(line!.quantity)).toBe(500);
  });

  it('a stale version is a conflict and writes nothing (presets included)', async () => {
    const seed = await seedLegacyRecipe();
    const result = await saveRecipeEditorAction({
      ...baseInput(),
      recipeId: seed.recipeId,
      expectedVersion: 2,
      name: 'Overwritten?',
      lines: [],
      sections: [],
      methodSections: [],
      steps: [],
      coverMediaId: null,
      presets: [],
    });
    expect(result).toEqual({ ok: false, code: 'WORKSPACE_VERSION_CONFLICT' });
    const [row] = await h.db.select().from(recipes).where(eq(recipes.id, seed.recipeId));
    expect(row).toMatchObject({ name: 'Brioche', version: 3 });
    const presets = await h.db.select().from(recipePresets).where(eq(recipePresets.recipeId, seed.recipeId));
    expect(presets).toHaveLength(3);
    const lines = await h.db.select().from(recipeIngredients).where(eq(recipeIngredients.recipeId, seed.recipeId));
    expect(lines).toHaveLength(3);
  });

  it('rolls back the whole save when the folder move fails', async () => {
    const seed = await seedLegacyRecipe();
    const result = await saveRecipeEditorAction({
      ...baseInput(),
      recipeId: seed.recipeId,
      expectedVersion: 3,
      name: 'Renamed',
      folderId: otherOrgFolderId,
      lines: [],
      sections: [],
      methodSections: [],
      steps: [],
      coverMediaId: null,
      presets: [],
    });
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND' });
    const [row] = await h.db.select().from(recipes).where(eq(recipes.id, seed.recipeId));
    expect(row).toMatchObject({ name: 'Brioche', version: 3, folderId: null });
    const lines = await h.db.select().from(recipeIngredients).where(eq(recipeIngredients.recipeId, seed.recipeId));
    expect(lines).toHaveLength(3);
  });

  it('cannot reach another organisation’s recipe', async () => {
    const seed = await seedLegacyRecipe();
    h.org = OTHER;
    const result = await saveRecipeEditorAction({
      ...baseInput(),
      recipeId: seed.recipeId,
      expectedVersion: 3,
      lines: [],
      sections: [],
      methodSections: [],
      steps: [],
      coverMediaId: null,
      presets: [],
    });
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND' });
    h.org = ORG;
    const [row] = await h.db.select().from(recipes).where(eq(recipes.id, seed.recipeId));
    expect(row).toMatchObject({ name: 'Brioche', version: 3 });
  });

  it('keeps one line per sub-recipe and refuses a sub-recipe without weight', async () => {
    const seed = await seedLegacyRecipe();
    const result = await saveRecipeEditorAction({
      ...baseInput(),
      recipeId: seed.recipeId,
      expectedVersion: 3,
      name: 'Brioche',
      lines: [{ kind: 'component', componentRecipeId: starterId, quantityGrams: 0, note: null, sectionRef: null }],
      sections: [],
      methodSections: [],
      steps: [],
      coverMediaId: null,
      presets: [],
    });
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' });
    const components = await h.db.select().from(recipeComponents).where(eq(recipeComponents.recipeId, seed.recipeId));
    expect(components).toHaveLength(0);
  });
});
