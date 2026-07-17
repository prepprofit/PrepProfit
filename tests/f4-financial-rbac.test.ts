import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { ingredients, recipes } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  toKitchenIngredient,
} from '@/lib/data/ingredients';
import {
  toKitchenRecipe,
  toKitchenRecipeWithIngredients,
} from '@/lib/data/recipes';

/**
 * Sprint F4 — RBAC financial lockdown. Proves the server (not just the UI) keeps
 * money away from kitchen:
 *   - the kitchen DTO projections OMIT the financial keys entirely;
 *   - forged kitchen create/update writes cannot introduce a cost/price (the server
 *     coerces on create, preserves on update, and the action responses carry no
 *     money keys);
 *   - changing the `dimension` of an ALREADY-PRICED ingredient is manager-only.
 * Auth/cache/audit/entitlements are mocked; the writes hit a real PGlite db so the
 * persisted rows can be inspected.
 */
const ORG = 'org_f4';

const h = vi.hoisted(() => ({
  db: null as unknown,
  manager: false,
}));

vi.mock('@/lib/auth', () => ({
  isManager: vi.fn(async () => h.manager),
  getOrgId: vi.fn(async () => ORG),
}));

vi.mock('@/lib/db', () => ({
  getDb: () => h.db,
  withOrg: async (org: string, fn: (tx: unknown) => unknown) =>
    runInOrg(h.db as TenantDb, org, fn as never),
}));

vi.mock('@/lib/data/audit', () => ({
  auditActor: vi.fn(async () => ({
    userId: 'user_1',
    role: h.manager ? 'manager' : 'kitchen',
    requestId: 'req_1',
  })),
  writeAuditEvent: vi.fn(async () => {}),
}));

vi.mock('@/lib/entitlements', () => ({
  assertPlanLimit: vi.fn(async () => ({
    allowed: true,
    limit: Infinity,
    tier: 'business' as const,
  })),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/analytics', () => ({ trackEvent: vi.fn(async () => {}) }));

import {
  createIngredientAction,
  updateIngredientAction,
} from '@/app/(app)/ingredients/actions';
import {
  createRecipeAction,
  updateRecipeAction,
} from '@/app/(app)/recipes/actions';

let client: PGlite;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  h.db = test.db;
});

afterAll(async () => {
  await client.close();
});

afterEach(() => {
  h.manager = false;
  vi.clearAllMocks();
});

/** Reads a persisted ingredient row straight from the db (org-scoped). */
async function readIngredient(id: string) {
  const rows = await runInOrg(h.db as TenantDb, ORG, (tx) =>
    tx
      .select()
      .from(ingredients)
      .where(and(eq(ingredients.organizationId, ORG), eq(ingredients.id, id)))
      .limit(1),
  );
  return rows[0];
}

async function readRecipe(id: string) {
  const rows = await runInOrg(h.db as TenantDb, ORG, (tx) =>
    tx
      .select()
      .from(recipes)
      .where(and(eq(recipes.organizationId, ORG), eq(recipes.id, id)))
      .limit(1),
  );
  return rows[0];
}

describe('kitchen DTO projections omit the financial keys', () => {
  it('toKitchenIngredient drops priceCents + pendingPriceCents', () => {
    const full = {
      id: 'i1',
      organizationId: ORG,
      name: 'Flour',
      dimension: 'weight' as const,
      priceCents: 1200,
      needsPricing: false,
      pendingPriceCents: 999,
      supplier: null,
      stockQuantity: '0',
      lowStockThreshold: null,
      allergensReviewedAt: null,
      allergensReviewedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    const view = toKitchenIngredient(full);
    expect('priceCents' in view).toBe(false);
    expect('pendingPriceCents' in view).toBe(false);
    expect(view.name).toBe('Flour');
  });

  it('toKitchenRecipe drops all recipe money keys', () => {
    const view = toKitchenRecipe({
      id: 'r1',
      organizationId: ORG,
      name: 'Bread',
      folderId: null,
      yieldPortions: 10,
      yieldPercentage: 90,
      yieldWeightGrams: null,
      laborCostCents: 500,
      energyCostCents: 100,
      packagingCostCents: 50,
      sellingPriceCents: 1000,
      notes: null,
      subtitle: null,
      version: 1,
      yieldQuantity: null,
      yieldUnit: null,
      nutritionServingQuantity: null,
      nutritionServingUnit: null,
      servingsPerContainer: null,
      coverMediaId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });
    expect('laborCostCents' in view).toBe(false);
    expect('energyCostCents' in view).toBe(false);
    expect('packagingCostCents' in view).toBe(false);
    expect('sellingPriceCents' in view).toBe(false);
  });

  it('toKitchenRecipeWithIngredients drops recipe money AND per-line price', () => {
    const view = toKitchenRecipeWithIngredients({
      recipe: {
        id: 'r1',
        organizationId: ORG,
        name: 'Bread',
        folderId: null,
        yieldPortions: 10,
        yieldPercentage: 90,
        yieldWeightGrams: null,
        laborCostCents: 500,
        energyCostCents: 100,
        packagingCostCents: 50,
        sellingPriceCents: 1000,
        notes: null,
        subtitle: null,
        version: 1,
        yieldQuantity: null,
        yieldUnit: null,
        nutritionServingQuantity: null,
        nutritionServingUnit: null,
        servingsPerContainer: null,
        coverMediaId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      },
      lines: [
        {
          id: 'l1',
          ingredientId: 'i1',
          quantity: 500,
          sortOrder: 0,
          ingredient: { name: 'Flour', dimension: 'weight', priceCents: 1200 },
        },
      ],
    });
    expect('sellingPriceCents' in view.recipe).toBe(false);
    expect('priceCents' in view.lines[0]!.ingredient).toBe(false);
    expect(view.lines[0]!.ingredient.name).toBe('Flour');
  });
});

describe('createIngredientAction — kitchen cannot forge a price', () => {
  it('forces priceCents=0 + needsPricing=true and returns no money key', async () => {
    h.manager = false;
    const result = await createIngredientAction({
      name: 'Kitchen Salt',
      dimension: 'weight',
      priceCents: 9999, // forged — must be ignored
      supplier: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('priceCents' in result.data).toBe(false);

    const row = await readIngredient(result.data.id);
    expect(row?.priceCents).toBe(0);
    expect(row?.needsPricing).toBe(true);
  });

  it('manager may set an opening price (response carries it)', async () => {
    h.manager = true;
    const result = await createIngredientAction({
      name: 'Manager Saffron',
      dimension: 'weight',
      priceCents: 5000,
      supplier: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('priceCents' in result.data).toBe(true);
    const row = await readIngredient(result.data.id);
    expect(row?.priceCents).toBe(5000);
  });
});

describe('updateIngredientAction — kitchen operational edits only', () => {
  async function seedPriced(name: string) {
    h.manager = true;
    const created = await createIngredientAction({
      name,
      dimension: 'weight',
      priceCents: 2000,
      supplier: null,
    });
    h.manager = false;
    if (!created.ok) throw new Error('seed failed');
    return created.data.id;
  }

  it('renames without touching the preserved price; response has no money key', async () => {
    const id = await seedPriced('Rename Me');
    const result = await updateIngredientAction(id, {
      name: 'Renamed',
      dimension: 'weight',
      supplier: 'ACME',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('priceCents' in result.data).toBe(false);
    const row = await readIngredient(id);
    expect(row?.name).toBe('Renamed');
    expect(row?.priceCents).toBe(2000); // preserved
  });

  it('refuses a dimension change on an already-priced ingredient (FORBIDDEN)', async () => {
    const id = await seedPriced('Dim Change');
    const result = await updateIngredientAction(id, {
      name: 'Dim Change',
      dimension: 'volume', // re-bases the price meaning — manager-only
      supplier: null,
    });
    expect(result).toEqual({ ok: false, code: 'FORBIDDEN' });
    const row = await readIngredient(id);
    expect(row?.dimension).toBe('weight'); // unchanged
  });

  it('allows a dimension change on a price-less ingredient', async () => {
    h.manager = false;
    const created = await createIngredientAction({
      name: 'Priceless',
      dimension: 'weight',
      supplier: null,
    });
    if (!created.ok) throw new Error('seed failed');
    const result = await updateIngredientAction(created.data.id, {
      name: 'Priceless',
      dimension: 'count',
      supplier: null,
    });
    expect(result.ok).toBe(true);
    const row = await readIngredient(created.data.id);
    expect(row?.dimension).toBe('count');
  });

  it('manager may still change the price (regression of the F2 gate)', async () => {
    const id = await seedPriced('Reprice');
    h.manager = true;
    const result = await updateIngredientAction(id, {
      name: 'Reprice',
      dimension: 'weight',
      priceCents: 3500,
      supplier: null,
    });
    expect(result.ok).toBe(true);
    const row = await readIngredient(id);
    expect(row?.priceCents).toBe(3500);
  });
});

describe('createRecipeAction — kitchen cannot forge recipe money', () => {
  it('zeroes all money fields and returns no money key', async () => {
    h.manager = false;
    const result = await createRecipeAction({
      name: 'Kitchen Loaf',
      yieldPortions: 8,
      yieldPercentage: 95,
      // forged money — must be dropped/zeroed
      laborCostCents: 4000,
      energyCostCents: 3000,
      packagingCostCents: 2000,
      sellingPriceCents: 9999,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('sellingPriceCents' in result.data).toBe(false);
    expect('laborCostCents' in result.data).toBe(false);

    const row = await readRecipe(result.data.id);
    expect(row?.laborCostCents).toBe(0);
    expect(row?.energyCostCents).toBe(0);
    expect(row?.packagingCostCents).toBe(0);
    expect(row?.sellingPriceCents).toBeNull();
  });

  it('manager may set recipe money', async () => {
    h.manager = true;
    const result = await createRecipeAction({
      name: 'Manager Loaf',
      yieldPortions: 8,
      yieldPercentage: 95,
      laborCostCents: 400,
      energyCostCents: 300,
      packagingCostCents: 200,
      sellingPriceCents: 1500,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await readRecipe(result.data.id);
    expect(row?.laborCostCents).toBe(400);
    expect(row?.sellingPriceCents).toBe(1500);
  });
});

describe('updateRecipeAction — kitchen preserves stored money', () => {
  it('edits operational fields and keeps the stored money; forged money is ignored', async () => {
    h.manager = true;
    const seed = await createRecipeAction({
      name: 'Preserve Me',
      yieldPortions: 4,
      yieldPercentage: 100,
      laborCostCents: 700,
      energyCostCents: 0,
      packagingCostCents: 0,
      sellingPriceCents: 2500,
    });
    if (!seed.ok) throw new Error('seed failed');
    const id = seed.data.id;

    h.manager = false;
    const result = await updateRecipeAction(id, {
      name: 'Preserved + Renamed',
      yieldPortions: 6,
      yieldPercentage: 90,
      // forged money — must be ignored, stored values kept
      laborCostCents: 99999,
      sellingPriceCents: 99999,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('sellingPriceCents' in result.data).toBe(false);

    const row = await readRecipe(id);
    expect(row?.name).toBe('Preserved + Renamed');
    expect(row?.yieldPortions).toBe(6);
    expect(row?.laborCostCents).toBe(700); // preserved
    expect(row?.sellingPriceCents).toBe(2500); // preserved
  });
});
