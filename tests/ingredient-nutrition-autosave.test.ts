import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { auditLog, ingredientNutritionProfiles } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { createIngredient } from '@/lib/data/ingredients';
import { NUTRIENT_KEYS, type NutrientKey } from '@/lib/calculations/nutrition';
import type { UsdaFood, UsdaResult } from '@/lib/usda/client';

/**
 * Ingredient-owned nutrition editor — autosave + explicit-match contract:
 *  - manual autosave MERGES a sparse patch (omitted = untouched, null = explicit
 *    clear, 0 = deliberate zero) and allows partial profiles;
 *  - invalid values are rejected with no write; an all-unknown first patch
 *    creates nothing;
 *  - a manual edit never silently replaces an external match
 *    (NUTRITION_SOURCE_CONFLICT) — only the explicit convert step does, which
 *    rescales the stored basis exactly to per 100 g;
 *  - kitchen is FORBIDDEN before data access; another org's ingredient is
 *    NOT_FOUND (RLS + lock) and never written;
 *  - the USDA preview never writes.
 * Real PGlite as tenant_app; auth, db, rate limit and the USDA client mocked.
 */

const ORG = 'org_nut_autosave';
const OTHER_ORG = 'org_nut_autosave_other';

const h = vi.hoisted(() => ({
  db: null as unknown as TenantDb,
  org: 'org_nut_autosave',
  manager: true,
  food: null as UsdaResult<UsdaFood> | null,
}));

vi.mock('@/lib/auth', () => ({
  getOrgId: vi.fn(async () => h.org),
  isManager: vi.fn(async () => h.manager),
  getUserId: vi.fn(async () => 'user_1'),
  getUserRole: vi.fn(async () => (h.manager ? 'manager' : 'kitchen')),
}));

vi.mock('@/lib/db', async () => {
  const { runInOrg: realRunInOrg } = await import('@/lib/db/tenant');
  return {
    getDb: () => h.db,
    withOrg: (org: string, fn: (tx: never) => unknown) => realRunInOrg(h.db, org, fn as never),
  };
});

vi.mock('@/lib/rate-limit', () => ({
  enforceRateLimit: vi.fn(async () => ({ allowed: true, remaining: 1, resetAt: new Date() })),
}));

vi.mock('@/lib/usda/client', () => ({
  searchUsdaFoods: vi.fn(async () => ({ ok: true, value: [] })),
  getUsdaFood: vi.fn(async () => h.food),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  previewUsdaFoodAction,
  saveIngredientNutritionAction,
  updateIngredientNutritionValuesAction,
} from '@/app/(app)/ingredients/nutrition-actions';

let client: PGlite;
let butterId: string;
let otherOrgIngredientId: string;

function nulls(): Record<NutrientKey, number | null> {
  const out = {} as Record<NutrientKey, number | null>;
  for (const k of NUTRIENT_KEYS) out[k] = null;
  return out;
}

async function profileRows(org = ORG) {
  return runInOrg(h.db, org, (tx) => tx.select().from(ingredientNutritionProfiles));
}

async function freshIngredient(name: string): Promise<string> {
  const ing = await runInOrg(h.db, ORG, (tx) =>
    createIngredient(tx, ORG, { name, dimension: 'weight', priceCents: 100 }),
  );
  return ing.id;
}

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  h.db = test.db as unknown as TenantDb;
  await h.db.execute(sql.raw('SET ROLE tenant_app;'));
  butterId = await freshIngredient('Butter');
  const other = await runInOrg(h.db, OTHER_ORG, (tx) =>
    createIngredient(tx, OTHER_ORG, { name: 'Their butter', priceCents: 100 }),
  );
  otherOrgIngredientId = other.id;
});

beforeEach(() => {
  h.manager = true;
  h.org = ORG;
});

afterAll(async () => {
  await h.db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

describe('RBAC', () => {
  it('kitchen is FORBIDDEN for autosave and preview, with no write', async () => {
    h.manager = false;
    expect(
      await updateIngredientNutritionValuesAction({
        ingredientId: butterId,
        values: { caloriesKcal: 1 },
      }),
    ).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(await previewUsdaFoodAction({ fdcId: 1 })).toEqual({ ok: false, code: 'FORBIDDEN' });
    h.manager = true;
    expect(await profileRows()).toHaveLength(0);
  });
});

describe('updateIngredientNutritionValuesAction — manual autosave', () => {
  it('an all-unknown first patch creates no profile', async () => {
    const r = await updateIngredientNutritionValuesAction({
      ingredientId: butterId,
      values: { caloriesKcal: null },
    });
    expect(r).toEqual({ ok: true, data: { view: null } });
    expect(await profileRows()).toHaveLength(0);
  });

  it('creates a PARTIAL manual profile from one value (not zero-filled)', async () => {
    const r = await updateIngredientNutritionValuesAction({
      ingredientId: butterId,
      values: { caloriesKcal: 717 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.view!.source).toBe('custom');
    expect(r.data.view!.values).toEqual({ ...nulls(), caloriesKcal: 717 });
    const rows = await profileRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.proteinG).toBeNull();
    const audits = await runInOrg(h.db, ORG, (tx) => tx.select().from(auditLog));
    expect(audits.some((a) => a.action === 'ingredient.nutritionSave')).toBe(true);
  });

  it('merges: omitted keys stay, a deliberate 0 is stored as 0', async () => {
    const r = await updateIngredientNutritionValuesAction({
      ingredientId: butterId,
      values: { totalCarbohydrateG: 0, proteinG: 0.9 },
    });
    expect(r.ok).toBe(true);
    const [row] = await profileRows();
    expect(row!.caloriesKcal).toBe(717); // untouched
    expect(row!.totalCarbohydrateG).toBe(0); // known zero, not unknown
    expect(row!.proteinG).toBe(0.9);
    expect(row!.sodiumMg).toBeNull(); // still unknown
  });

  it('an explicit null clears ONE saved value', async () => {
    const r = await updateIngredientNutritionValuesAction({
      ingredientId: butterId,
      values: { proteinG: null },
    });
    expect(r.ok).toBe(true);
    const [row] = await profileRows();
    expect(row!.proteinG).toBeNull();
    expect(row!.caloriesKcal).toBe(717);
    expect(row!.totalCarbohydrateG).toBe(0);
  });

  it('rejects invalid values (negative, over max, NaN, Infinity, strings, unknown keys) with no write', async () => {
    const before = await profileRows();
    const bad: unknown[] = [
      { caloriesKcal: -1 },
      { caloriesKcal: 5000 },
      { caloriesKcal: Number.NaN },
      { caloriesKcal: Number.POSITIVE_INFINITY },
      { caloriesKcal: '12' },
      { calories: 12 },
    ];
    for (const values of bad) {
      expect(
        await updateIngredientNutritionValuesAction({ ingredientId: butterId, values }),
      ).toEqual({ ok: false, code: 'INVALID_INPUT' });
    }
    expect(await profileRows()).toEqual(before);
  });

  it('unknown / trashed-or-foreign ingredient → NOT_FOUND', async () => {
    expect(
      await updateIngredientNutritionValuesAction({
        ingredientId: '00000000-0000-0000-0000-000000000000',
        values: { caloriesKcal: 1 },
      }),
    ).toEqual({ ok: false, code: 'NOT_FOUND' });
  });
});

describe('external matches are never silently replaced', () => {
  it('a manual patch on a USDA match is NUTRITION_SOURCE_CONFLICT (no write)', async () => {
    const milkId = await freshIngredient('Milk powder');
    h.food = {
      ok: true,
      value: {
        fdcId: 555,
        description: 'Milk, dry, whole',
        dataType: 'Foundation',
        brandOwner: null,
        publishedDate: '2024-04-01',
        nutrientsPer100g: {
          ...nulls(),
          caloriesKcal: 496,
          totalFatG: 26.7,
          totalCarbohydrateG: 38.4,
          proteinG: 26.3,
          sodiumMg: 371,
        },
      },
    };
    // "Use this match" — the one explicit save.
    const saved = await saveIngredientNutritionAction({
      source: 'usda',
      ingredientId: milkId,
      fdcId: 555,
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.data.view.source).toBe('usda');
    expect(saved.data.view.externalId).toBe('555');

    expect(
      await updateIngredientNutritionValuesAction({
        ingredientId: milkId,
        values: { caloriesKcal: 1 },
      }),
    ).toEqual({ ok: false, code: 'NUTRITION_SOURCE_CONFLICT' });
    const row = (await profileRows()).find((p) => p.ingredientId === milkId)!;
    expect(row.source).toBe('usda');
    expect(row.caloriesKcal).toBe(496);

    // The explicit "Edit values manually" step converts, keeping the values.
    const converted = await updateIngredientNutritionValuesAction({
      ingredientId: milkId,
      values: {},
      convertExternal: true,
    });
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    expect(converted.data.view!.source).toBe('custom');
    expect(converted.data.view!.externalId).toBeNull();
    expect(converted.data.view!.values.caloriesKcal).toBe(496);
    expect(converted.data.view!.values.proteinG).toBe(26.3);
  });

  it('converting a per-100 ml match rescales exactly to per 100 g', async () => {
    const creamId = await freshIngredient('Cream');
    // Seed a per-100 ml Open Food Facts profile whose 100 ml weighs 102 g.
    await runInOrg(h.db, ORG, (tx) =>
      tx.insert(ingredientNutritionProfiles).values({
        organizationId: ORG,
        ingredientId: creamId,
        source: 'open_food_facts',
        externalSourceId: '3017620422003',
        barcode: '3017620422003',
        qualityWarnings: ['BASIS_VOLUME'],
        basisGrams: 102,
        caloriesKcal: 204,
        proteinG: 2.04,
      }),
    );
    const r = await updateIngredientNutritionValuesAction({
      ingredientId: creamId,
      values: {},
      convertExternal: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.view!.basisGrams).toBe(100);
    expect(r.data.view!.basisUnit).toBe('g');
    expect(r.data.view!.values.caloriesKcal).toBeCloseTo(200, 4);
    expect(r.data.view!.values.proteinG).toBeCloseTo(2, 4);
    expect(r.data.view!.values.sodiumMg).toBeNull();
  });
});

describe('tenant isolation', () => {
  it("another org's ingredient is NOT_FOUND and never gains a profile", async () => {
    expect(
      await updateIngredientNutritionValuesAction({
        ingredientId: otherOrgIngredientId,
        values: { caloriesKcal: 1 },
      }),
    ).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await profileRows(OTHER_ORG)).toHaveLength(0);

    // Org B cannot reach org A's ingredient either.
    h.org = OTHER_ORG;
    expect(
      await updateIngredientNutritionValuesAction({
        ingredientId: butterId,
        values: { caloriesKcal: 1 },
      }),
    ).toEqual({ ok: false, code: 'NOT_FOUND' });
    h.org = ORG;
    const butter = (await profileRows()).find((p) => p.ingredientId === butterId)!;
    expect(butter.caloriesKcal).toBe(717);
  });
});

describe('previewUsdaFoodAction', () => {
  it('returns the food and never writes a profile', async () => {
    const pastryId = await freshIngredient('Pastry flour');
    h.food = {
      ok: true,
      value: {
        fdcId: 999,
        description: 'Flour, pastry',
        dataType: 'SR Legacy',
        brandOwner: null,
        publishedDate: null,
        nutrientsPer100g: { ...nulls(), caloriesKcal: 358 },
      },
    };
    const r = await previewUsdaFoodAction({ fdcId: 999 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.food.description).toBe('Flour, pastry');
    expect((await profileRows()).some((p) => p.ingredientId === pastryId)).toBe(false);
    expect(await previewUsdaFoodAction({ fdcId: -3 })).toEqual({
      ok: false,
      code: 'INVALID_INPUT',
    });
  });
});
