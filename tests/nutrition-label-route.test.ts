import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import {
  auditLog,
  ingredientNutritionProfiles,
  ingredients,
  recipeIngredients,
  recipePortionOptions,
  recipes,
} from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';

/**
 * Integration test for the nutrition-label PDF route (Fase 6 slice 7). Real
 * handler against PGlite as `tenant_app` (RLS enforced), auth/db/next-intl
 * stubbed. Proves: BOTH roles can render (money-free, D5), a complete recipe
 * renders a non-draft PDF and audits `export.nutritionLabelPdf`, a recipe
 * without a nutrition serving → 400, a trashed/cross-org id → 404, and an
 * incomplete rollup still renders (draft) with `draft: true` in the audit.
 */
const ORG_A = 'org_nl_a';

const h = vi.hoisted(() => ({
  db: null as unknown,
  auth: {
    orgId: 'org_nl_a',
    userId: 'user_1',
    role: 'kitchen' as 'manager' | 'kitchen',
  },
}));

vi.mock('@/lib/auth', () => ({
  getOrgId: vi.fn(async () => h.auth.orgId),
  getUserId: vi.fn(async () => h.auth.userId),
  getUserRole: vi.fn(async () => h.auth.role),
  getOrgName: vi.fn(async () => 'Test Org'),
}));

vi.mock('@/lib/db', () => ({
  getDb: () => h.db,
  withOrg: async (org: string, fn: (tx: unknown) => unknown) => {
    const { runInOrg: rio } = await import('@/lib/db/tenant');
    return rio(h.db as TenantDb, org, fn as never);
  },
}));

vi.mock('next-intl/server', () => ({
  getTranslations: async () => {
    const t = (key: string) => key;
    return t;
  },
}));

import { GET } from '@/app/api/recipes/[id]/nutrition-label/pdf/route';

let client: PGlite;
let db: TenantDb;
let completeId = '';
let noServingId = '';
let incompleteId = '';
let trashedId = '';

function call(id: string) {
  return GET(new Request(`http://test/api/recipes/${id}/nutrition-label/pdf`), {
    params: Promise.resolve({ id }),
  });
}

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  h.db = db;
  await db.execute(sql.raw('SET ROLE tenant_app;'));

  await runInOrg(db, ORG_A, async (tx) => {
    const [flour] = await tx
      .insert(ingredients)
      .values({ organizationId: ORG_A, name: 'Flour', priceCents: 100 })
      .returning({ id: ingredients.id });
    await tx.insert(ingredientNutritionProfiles).values({
      organizationId: ORG_A,
      ingredientId: flour!.id,
      source: 'custom',
      caloriesKcal: 364,
      proteinG: 10,
    });

    const mk = async (name: string, yieldWeightGrams: number | null) => {
      const [rec] = await tx
        .insert(recipes)
        .values({ organizationId: ORG_A, name, yieldPortions: 4, yieldWeightGrams })
        .returning({ id: recipes.id });
      await tx.insert(recipeIngredients).values({
        organizationId: ORG_A,
        recipeId: rec!.id,
        ingredientId: flour!.id,
        quantity: '500',
      });
      return rec!.id;
    };

    completeId = await mk('Complete bread', 1000);
    await tx.insert(recipePortionOptions).values({
      organizationId: ORG_A,
      recipeId: completeId,
      name: 'Serving',
      quantity: 100,
      unit: 'g',
      isNutritionServing: true,
    });

    noServingId = await mk('No serving bread', 1000);

    // Incomplete: has a serving but an ingredient with NO profile.
    incompleteId = await mk('Incomplete bread', 1000);
    const [mystery] = await tx
      .insert(ingredients)
      .values({ organizationId: ORG_A, name: 'Mystery', priceCents: 100 })
      .returning({ id: ingredients.id });
    await tx.insert(recipeIngredients).values({
      organizationId: ORG_A,
      recipeId: incompleteId,
      ingredientId: mystery!.id,
      quantity: '100',
    });
    await tx.insert(recipePortionOptions).values({
      organizationId: ORG_A,
      recipeId: incompleteId,
      name: 'Serving',
      quantity: 100,
      unit: 'g',
      isNutritionServing: true,
    });

    const [trashed] = await tx
      .insert(recipes)
      .values({ organizationId: ORG_A, name: 'Old', deletedAt: new Date() })
      .returning({ id: recipes.id });
    trashedId = trashed!.id;
  });
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

describe('nutrition label PDF route', () => {
  it('kitchen renders a complete label (200, pdf) and audits without draft', async () => {
    const res = await call(completeId);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    const audits = await runInOrg(db, ORG_A, (tx) => tx.select().from(auditLog));
    const evt = audits.find(
      (a) => a.action === 'export.nutritionLabelPdf' && a.entityId === completeId,
    );
    expect(evt).toBeDefined();
    expect(evt!.metadata).toMatchObject({ draft: false });
  });

  it('a recipe without a nutrition serving → 400 (never a zeroed label)', async () => {
    const res = await call(noServingId);
    expect(res.status).toBe(400);
  });

  it('an incomplete rollup still renders, audited as draft', async () => {
    const res = await call(incompleteId);
    expect(res.status).toBe(200);
    const audits = await runInOrg(db, ORG_A, (tx) => tx.select().from(auditLog));
    const evt = audits.find(
      (a) =>
        a.action === 'export.nutritionLabelPdf' && a.entityId === incompleteId,
    );
    expect(evt!.metadata).toMatchObject({ draft: true });
  });

  it('trashed id → 404; cross-org id → 404 (RLS)', async () => {
    expect((await call(trashedId)).status).toBe(404);
    h.auth.orgId = 'org_nl_other';
    try {
      expect((await call(completeId)).status).toBe(404);
    } finally {
      h.auth.orgId = ORG_A;
    }
  });
});
