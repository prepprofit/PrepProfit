import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
 * Fase 6 slice 4 — RBAC + trust boundary of the nutrition actions:
 *  - all three actions are MANAGER-ONLY (FORBIDDEN before any data access);
 *  - a USDA save re-fetches the food SERVER-side (client nutrient values are
 *    never persisted on the usda path) and snapshots + audits;
 *  - a custom save persists the Zod-bounded client values + audits;
 *  - refresh on a custom/missing profile is NOT_FOUND;
 *  - the search rate limit answers RATE_LIMITED, and an unconfigured USDA key
 *    maps to USDA_NOT_CONFIGURED (D1 custom-only mode).
 * Real PGlite as tenant_app; auth, db, rate limit and the USDA client mocked.
 */

const ORG = 'org_nut_authz';

const h = vi.hoisted(() => ({
  db: null as unknown as TenantDb,
  org: 'org_nut_authz',
  manager: true,
  rateAllowed: true,
  search: null as UsdaResult<UsdaFood[]> | null,
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
    withOrg: (org: string, fn: (tx: never) => unknown) =>
      realRunInOrg(h.db, org, fn as never),
  };
});

vi.mock('@/lib/rate-limit', () => ({
  enforceRateLimit: vi.fn(async () => ({
    allowed: h.rateAllowed,
    remaining: h.rateAllowed ? 1 : 0,
    resetAt: new Date(),
  })),
}));

vi.mock('@/lib/usda/client', () => ({
  searchUsdaFoods: vi.fn(async () => h.search),
  getUsdaFood: vi.fn(async () => h.food),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  refreshIngredientNutritionAction,
  saveIngredientNutritionAction,
  searchUsdaFoodsAction,
} from '@/app/(app)/ingredients/nutrition-actions';
import { getUsdaFood } from '@/lib/usda/client';

let client: PGlite;
let ingredientId: string;

function values(v: number | null): Record<NutrientKey, number | null> {
  const out = {} as Record<NutrientKey, number | null>;
  for (const k of NUTRIENT_KEYS) out[k] = v;
  return out;
}

function usdaFood(overrides: Partial<UsdaFood> = {}): UsdaFood {
  return {
    fdcId: 777,
    description: 'Server-side milk',
    dataType: 'Foundation',
    brandOwner: null,
    publishedDate: '2024-04-01',
    nutrientsPer100g: { ...values(null), caloriesKcal: 61, proteinG: 3.2 },
    ...overrides,
  };
}

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  h.db = test.db as unknown as TenantDb;
  await h.db.execute(sql.raw('SET ROLE tenant_app;'));
  const ing = await runInOrg(h.db, ORG, (tx) =>
    createIngredient(tx, ORG, { name: 'Milk', dimension: 'volume', priceCents: 100 }),
  );
  ingredientId = ing.id;
});

afterAll(async () => {
  await h.db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

describe('RBAC — kitchen gets FORBIDDEN before any data access', () => {
  it('all three actions', async () => {
    h.manager = false;
    try {
      expect(await searchUsdaFoodsAction({ query: 'milk', scope: 'common' })).toEqual({
        ok: false,
        code: 'FORBIDDEN',
      });
      expect(
        await saveIngredientNutritionAction({
          source: 'custom',
          ingredientId,
          values: values(1),
        }),
      ).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(
        await refreshIngredientNutritionAction({ ingredientId }),
      ).toEqual({ ok: false, code: 'FORBIDDEN' });
    } finally {
      h.manager = true;
    }
  });
});

describe('searchUsdaFoodsAction', () => {
  it('maps NOT_CONFIGURED (D1) and RATE_LIMITED', async () => {
    h.search = { ok: false, reason: 'NOT_CONFIGURED' };
    expect(await searchUsdaFoodsAction({ query: 'milk', scope: 'common' })).toEqual({
      ok: false,
      code: 'USDA_NOT_CONFIGURED',
    });

    h.rateAllowed = false;
    try {
      expect(await searchUsdaFoodsAction({ query: 'milk', scope: 'common' })).toEqual({
        ok: false,
        code: 'RATE_LIMITED',
      });
    } finally {
      h.rateAllowed = true;
    }
  });

  it('rejects a malformed query with INVALID_INPUT', async () => {
    expect(await searchUsdaFoodsAction({ query: 'a', scope: 'common' })).toEqual({
      ok: false,
      code: 'INVALID_INPUT',
    });
    expect(await searchUsdaFoodsAction({ query: 'milk', scope: 'nope' })).toEqual({
      ok: false,
      code: 'INVALID_INPUT',
    });
  });

  it('returns the normalized foods on success', async () => {
    h.search = { ok: true, value: [usdaFood()] };
    const r = await searchUsdaFoodsAction({ query: 'milk', scope: 'common' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.foods[0]!.fdcId).toBe(777);
  });
});

describe('saveIngredientNutritionAction — custom', () => {
  it('persists bounded values and audits', async () => {
    const r = await saveIngredientNutritionAction({
      source: 'custom',
      ingredientId,
      values: { ...values(null), caloriesKcal: 42, sodiumMg: 120 },
    });
    expect(r.ok).toBe(true);
    const rows = await runInOrg(h.db, ORG, (tx) =>
      tx.select().from(ingredientNutritionProfiles),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('custom');
    expect(rows[0]!.caloriesKcal).toBe(42);
    expect(rows[0]!.fdcId).toBeNull();
  });

  it('rejects out-of-bounds custom values (INVALID_INPUT, no write)', async () => {
    expect(
      await saveIngredientNutritionAction({
        source: 'custom',
        ingredientId,
        values: { ...values(null), caloriesKcal: 5000 },
      }),
    ).toEqual({ ok: false, code: 'INVALID_INPUT' });
    expect(
      await saveIngredientNutritionAction({
        source: 'custom',
        ingredientId,
        values: { ...values(null), proteinG: -1 },
      }),
    ).toEqual({ ok: false, code: 'INVALID_INPUT' });
  });

  it('unknown ingredient → NOT_FOUND', async () => {
    expect(
      await saveIngredientNutritionAction({
        source: 'custom',
        ingredientId: '00000000-0000-0000-0000-000000000000',
        values: values(1),
      }),
    ).toEqual({ ok: false, code: 'NOT_FOUND' });
  });
});

describe('saveIngredientNutritionAction — usda', () => {
  it('snapshots the SERVER-fetched food, never client values', async () => {
    h.food = { ok: true, value: usdaFood() };
    const r = await saveIngredientNutritionAction({
      source: 'usda',
      ingredientId,
      fdcId: 777,
      // Extra client-side junk must be ignored by the schema/action.
      values: { caloriesKcal: 99999 },
    });
    expect(r.ok).toBe(true);
    expect(getUsdaFood).toHaveBeenCalledWith(777);
    const rows = await runInOrg(h.db, ORG, (tx) =>
      tx.select().from(ingredientNutritionProfiles),
    );
    expect(rows).toHaveLength(1); // upserted over the custom profile
    expect(rows[0]!.source).toBe('usda');
    expect(rows[0]!.caloriesKcal).toBe(61); // server value, not 99999
    expect(rows[0]!.sourceDescription).toBe('Server-side milk');

    const audits = await runInOrg(h.db, ORG, (tx) => tx.select().from(auditLog));
    expect(
      audits.filter((a) => a.action === 'ingredient.nutritionSave').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('maps an unavailable USDA API to USDA_UNAVAILABLE', async () => {
    h.food = { ok: false, reason: 'UNAVAILABLE' };
    expect(
      await saveIngredientNutritionAction({ source: 'usda', ingredientId, fdcId: 777 }),
    ).toEqual({ ok: false, code: 'USDA_UNAVAILABLE' });
  });
});

describe('refreshIngredientNutritionAction', () => {
  it('refreshes an existing usda profile and audits nutritionRefresh', async () => {
    h.food = {
      ok: true,
      value: usdaFood({
        nutrientsPer100g: { ...values(null), caloriesKcal: 64 },
      }),
    };
    const r = await refreshIngredientNutritionAction({ ingredientId });
    expect(r.ok).toBe(true);
    const rows = await runInOrg(h.db, ORG, (tx) =>
      tx.select().from(ingredientNutritionProfiles),
    );
    expect(rows[0]!.caloriesKcal).toBe(64);
    const audits = await runInOrg(h.db, ORG, (tx) => tx.select().from(auditLog));
    expect(audits.some((a) => a.action === 'ingredient.nutritionRefresh')).toBe(true);
  });

  it('custom/missing profile → NOT_FOUND without calling USDA', async () => {
    // Overwrite with a custom profile first.
    await saveIngredientNutritionAction({
      source: 'custom',
      ingredientId,
      values: values(1),
    });
    vi.mocked(getUsdaFood).mockClear();
    expect(await refreshIngredientNutritionAction({ ingredientId })).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
    expect(getUsdaFood).not.toHaveBeenCalled();
  });
});
