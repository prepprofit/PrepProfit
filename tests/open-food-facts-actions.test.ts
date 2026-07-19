import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';

import { createTestDb } from './helpers/db';
import {
  auditLog,
  ingredientNutritionProfiles,
  ingredientUomEquivalencies,
} from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { createIngredient } from '@/lib/data/ingredients';
import { NUTRIENT_KEYS, type NutrientKey } from '@/lib/calculations/nutrition';
import type { ExternalFoodSnapshot } from '@/lib/external-food/types';
import type { OffResolveResult } from '@/lib/open-food-facts/resolve';

/**
 * Open Food Facts action layer (plan §14): manager-only authorization before any
 * access, local barcode validation, server-side re-resolve (browser nutrient
 * values never trusted), partial-confirmation gate, the 100 ml basis/equivalency
 * gate, stable error mapping, and audit metadata that carries identifiers not
 * nutrients. Real PGlite as tenant_app; auth/db/rate-limit/resolver mocked.
 */

const ORG = 'org_off_actions';
const BARCODE = '3017620422003';

const h = vi.hoisted(() => ({
  db: null as unknown as TenantDb,
  org: 'org_off_actions',
  manager: true,
  rateAllowed: true,
  resolved: null as OffResolveResult | null,
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

vi.mock('@/lib/open-food-facts/resolve', () => ({
  resolveOffByBarcode: vi.fn(async () => h.resolved),
  resetOffResolverState: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  lookupExternalFoodByBarcodeAction,
  refreshIngredientNutritionAction,
  saveIngredientNutritionAction,
} from '@/app/(app)/ingredients/nutrition-actions';
import { resolveOffByBarcode } from '@/lib/open-food-facts/resolve';

let client: PGlite;
let solidIngredientId: string;
let beverageIngredientId: string;
let beverageWithDensityId: string;

function values(v: number | null): Record<NutrientKey, number | null> {
  const out = {} as Record<NutrientKey, number | null>;
  for (const k of NUTRIENT_KEYS) out[k] = v;
  return out;
}

function makeSnapshot(overrides: Partial<ExternalFoodSnapshot> = {}): ExternalFoodSnapshot {
  return {
    provider: 'open_food_facts',
    externalId: BARCODE,
    barcode: BARCODE,
    description: 'Nutella',
    brandOwner: 'Ferrero',
    packageQuantity: '400 g',
    sourceCountry: 'france',
    sourceLanguage: 'fr',
    sourceRevision: '214',
    sourceUpdatedAt: new Date('2024-03-01'),
    basis: { quantity: 100, unit: 'g' },
    nutrients: {
      ...values(null),
      caloriesKcal: 539,
      totalFatG: 30.9,
      totalCarbohydrateG: 57.5,
      proteinG: 6.3,
      sodiumMg: 42.8,
    },
    saltG: 0.107,
    derivedFields: [],
    qualityStatus: 'complete',
    qualityWarnings: [],
    normalizationVersion: 1,
    ...overrides,
  };
}

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  h.db = test.db as unknown as TenantDb;
  await h.db.execute(sql.raw('SET ROLE tenant_app;'));

  const solid = await runInOrg(h.db, ORG, (tx) =>
    createIngredient(tx, ORG, { name: 'Spread', dimension: 'weight', priceCents: 100 }),
  );
  solidIngredientId = solid.id;
  const bev = await runInOrg(h.db, ORG, (tx) =>
    createIngredient(tx, ORG, { name: 'Cola', dimension: 'volume', priceCents: 100 }),
  );
  beverageIngredientId = bev.id;
  const bevD = await runInOrg(h.db, ORG, (tx) =>
    createIngredient(tx, ORG, { name: 'Syrup', dimension: 'volume', priceCents: 100 }),
  );
  beverageWithDensityId = bevD.id;
  // Density equivalency: 100 ml weighs 110 g.
  await runInOrg(h.db, ORG, (tx) =>
    tx.insert(ingredientUomEquivalencies).values({
      organizationId: ORG,
      ingredientId: beverageWithDensityId,
      weightGrams: 110,
      volumeMl: 100,
      eachCount: null,
    }),
  );
});

afterAll(async () => {
  await h.db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

beforeEach(() => {
  h.manager = true;
  h.rateAllowed = true;
  h.resolved = null;
  vi.mocked(resolveOffByBarcode).mockClear();
});

describe('authorization + input validation', () => {
  it('kitchen gets FORBIDDEN before any resolve (lookup + save)', async () => {
    h.manager = false;
    expect(
      await lookupExternalFoodByBarcodeAction({ ingredientId: solidIngredientId, barcode: BARCODE }),
    ).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(
      await saveIngredientNutritionAction({
        source: 'open_food_facts',
        ingredientId: solidIngredientId,
        barcode: BARCODE,
      }),
    ).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(resolveOffByBarcode).not.toHaveBeenCalled();
  });

  it('rejects an invalid barcode before resolving', async () => {
    expect(
      await lookupExternalFoodByBarcodeAction({
        ingredientId: solidIngredientId,
        barcode: '3017620422004', // bad check digit
      }),
    ).toEqual({ ok: false, code: 'INVALID_BARCODE' });
    expect(resolveOffByBarcode).not.toHaveBeenCalled();
  });

  it('RATE_LIMITED short-circuits before resolving', async () => {
    h.rateAllowed = false;
    expect(
      await lookupExternalFoodByBarcodeAction({ ingredientId: solidIngredientId, barcode: BARCODE }),
    ).toEqual({ ok: false, code: 'RATE_LIMITED' });
    expect(resolveOffByBarcode).not.toHaveBeenCalled();
  });
});

describe('lookupExternalFoodByBarcodeAction', () => {
  it('returns a preview for a solid product (no equivalency needed)', async () => {
    h.resolved = { ok: true, snapshot: makeSnapshot(), stale: false };
    const r = await lookupExternalFoodByBarcodeAction({
      ingredientId: solidIngredientId,
      barcode: BARCODE,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.preview.description).toBe('Nutella');
    expect(r.data.preview.basisUnit).toBe('g');
    expect(r.data.preview.requiresEquivalency).toBe(false);
    expect(r.data.preview.sourceUpdatedAt).toBe('2024-03-01T00:00:00.000Z');
  });

  it('flags a 100 ml product on an ingredient without equivalency', async () => {
    h.resolved = {
      ok: true,
      snapshot: makeSnapshot({ basis: { quantity: 100, unit: 'ml' } }),
      stale: false,
    };
    const r = await lookupExternalFoodByBarcodeAction({
      ingredientId: beverageIngredientId,
      barcode: BARCODE,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.preview.requiresEquivalency).toBe(true);
  });

  it('maps provider failures to stable codes', async () => {
    const cases: [OffResolveResult, string][] = [
      [{ ok: false, reason: 'NOT_FOUND' }, 'EXTERNAL_PRODUCT_NOT_FOUND'],
      [{ ok: false, reason: 'DISABLED' }, 'OPEN_FOOD_FACTS_DISABLED'],
      [{ ok: false, reason: 'UNAVAILABLE' }, 'OPEN_FOOD_FACTS_UNAVAILABLE'],
      [{ ok: false, reason: 'NON_FOOD' }, 'EXTERNAL_PRODUCT_INVALID'],
      [{ ok: false, reason: 'BASIS_UNSUPPORTED' }, 'NUTRITION_BASIS_UNSUPPORTED'],
    ];
    for (const [resolved, code] of cases) {
      h.resolved = resolved;
      expect(
        await lookupExternalFoodByBarcodeAction({ ingredientId: solidIngredientId, barcode: BARCODE }),
      ).toEqual({ ok: false, code });
    }
  });
});

describe('saveIngredientNutritionAction — open_food_facts', () => {
  it('snapshots the SERVER-resolved values, never client-supplied ones', async () => {
    h.resolved = { ok: true, snapshot: makeSnapshot(), stale: false };
    const r = await saveIngredientNutritionAction({
      source: 'open_food_facts',
      ingredientId: solidIngredientId,
      barcode: BARCODE,
      // Junk that must be stripped by the schema and never persisted.
      values: { caloriesKcal: 99999 },
    });
    expect(r.ok).toBe(true);
    const rows = await runInOrg(h.db, ORG, (tx) =>
      tx.select().from(ingredientNutritionProfiles),
    );
    const row = rows.find((p) => p.ingredientId === solidIngredientId)!;
    expect(row.source).toBe('open_food_facts');
    expect(row.caloriesKcal).toBe(539); // server value, not 99999
    expect(row.externalSourceId).toBe(BARCODE);
    expect(row.barcode).toBe(BARCODE);
    expect(row.saltG).toBe(0.107);
    expect(row.fdcId).toBeNull();
  });

  it('audit metadata carries identifiers, not the nutrient payload', async () => {
    const audits = await runInOrg(h.db, ORG, (tx) => tx.select().from(auditLog));
    const evt = audits.find(
      (a) =>
        a.action === 'ingredient.nutritionSave' &&
        (a.metadata as { source?: string }).source === 'open_food_facts',
    );
    expect(evt).toBeDefined();
    expect(evt!.metadata).toMatchObject({
      source: 'open_food_facts',
      externalId: BARCODE,
      qualityStatus: 'complete',
    });
    expect(JSON.stringify(evt!.metadata)).not.toContain('caloriesKcal');
  });

  it('a partial product requires explicit confirmation', async () => {
    h.resolved = {
      ok: true,
      snapshot: makeSnapshot({ qualityStatus: 'partial', qualityWarnings: ['MISSING_CORE_NUTRIENT'] }),
      stale: false,
    };
    expect(
      await saveIngredientNutritionAction({
        source: 'open_food_facts',
        ingredientId: solidIngredientId,
        barcode: BARCODE,
      }),
    ).toEqual({ ok: false, code: 'EXTERNAL_PRODUCT_PARTIAL' });

    const ok = await saveIngredientNutritionAction({
      source: 'open_food_facts',
      ingredientId: solidIngredientId,
      barcode: BARCODE,
      confirmPartial: true,
    });
    expect(ok.ok).toBe(true);
  });

  it('blocks a 100 ml product without an equivalency; allows it with one', async () => {
    h.resolved = {
      ok: true,
      snapshot: makeSnapshot({ basis: { quantity: 100, unit: 'ml' } }),
      stale: false,
    };
    expect(
      await saveIngredientNutritionAction({
        source: 'open_food_facts',
        ingredientId: beverageIngredientId,
        barcode: BARCODE,
      }),
    ).toEqual({ ok: false, code: 'NUTRITION_EQUIVALENCY_REQUIRED' });

    const ok = await saveIngredientNutritionAction({
      source: 'open_food_facts',
      ingredientId: beverageWithDensityId,
      barcode: BARCODE,
    });
    expect(ok.ok).toBe(true);
    const rows = await runInOrg(h.db, ORG, (tx) =>
      tx.select().from(ingredientNutritionProfiles),
    );
    const row = rows.find((p) => p.ingredientId === beverageWithDensityId)!;
    // 100 ml → 110 g basis (density 1.1), values unchanged.
    expect(row.basisGrams).toBe(110);
    expect(row.caloriesKcal).toBe(539);
  });
});

describe('refreshIngredientNutritionAction — dispatch by provider', () => {
  it('refreshes an OFF profile via OFF (forceRefresh) and keeps identity', async () => {
    h.resolved = { ok: true, snapshot: makeSnapshot(), stale: false };
    await saveIngredientNutritionAction({
      source: 'open_food_facts',
      ingredientId: solidIngredientId,
      barcode: BARCODE,
    });

    h.resolved = {
      ok: true,
      snapshot: makeSnapshot({ nutrients: { ...values(null), caloriesKcal: 500 } }),
      stale: false,
    };
    vi.mocked(resolveOffByBarcode).mockClear();
    const r = await refreshIngredientNutritionAction({ ingredientId: solidIngredientId });
    expect(r.ok).toBe(true);
    expect(resolveOffByBarcode).toHaveBeenCalledWith(expect.anything(), BARCODE, {
      forceRefresh: true,
    });
    const rows = await runInOrg(h.db, ORG, (tx) =>
      tx.select().from(ingredientNutritionProfiles),
    );
    const row = rows.find((p) => p.ingredientId === solidIngredientId)!;
    expect(row.caloriesKcal).toBe(500);
    expect(row.source).toBe('open_food_facts');
    const audits = await runInOrg(h.db, ORG, (tx) => tx.select().from(auditLog));
    expect(audits.some((a) => a.action === 'ingredient.nutritionRefresh')).toBe(true);
  });
});
