import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import {
  organizationSettings,
  recipes,
  ingredients,
  recipeIngredients,
  auditLog,
  rateLimits,
} from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { rateLimitKey } from '@/lib/rate-limit';

/**
 * Integration test for the operational prep-card PDF route (Recipe scaling MVP).
 * Runs the real handler against PGlite under the non-privileged `tenant_app` role
 * (RLS enforced), with `@/lib/auth`, `@/lib/db` and next-intl stubbed. Proves: BOTH
 * roles can render (no RBAC gate — the card is money-free), a scaled request renders,
 * an invalid `?portions=` → 400, render audits `export.recipePrepCardPdf` in the
 * active org only, a trashed/cross-org id → 404 with no audit leak, and the
 * `documents` rate limit returns 429.
 */
const ORG_A = 'org_a';
const ORG_B = 'org_b';

const h = vi.hoisted(() => ({
  db: null as unknown,
  auth: { orgId: 'org_a', userId: 'user_1', role: 'kitchen' as 'manager' | 'kitchen' },
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
  getTranslations: async () => (key: string) => key,
}));

import { GET } from '@/app/api/recipes/[id]/prep-card/pdf/route';

let client: PGlite;
let db: TenantDb;
let recipeId = '';
let trashedId = '';

function call(id: string, query = '') {
  return GET(new Request(`http://test/api/recipes/${id}/prep-card/pdf${query}`), {
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
    await tx.insert(organizationSettings).values({
      organizationId: ORG_A,
      currency: 'EUR',
      measurementSystem: 'metric',
      businessName: 'Padaria do Bairro',
    });
    const [rec] = await tx
      .insert(recipes)
      .values({
        organizationId: ORG_A,
        name: 'Sourdough loaf',
        yieldPortions: 4,
        yieldPercentage: 90,
        laborCostCents: 500,
        sellingPriceCents: 600,
      })
      .returning({ id: recipes.id });
    recipeId = rec!.id;

    const [flour] = await tx
      .insert(ingredients)
      .values({
        organizationId: ORG_A,
        name: 'Flour',
        dimension: 'weight',
        priceCents: 120,
      })
      .returning({ id: ingredients.id });
    await tx.insert(recipeIngredients).values({
      organizationId: ORG_A,
      recipeId,
      ingredientId: flour!.id,
      quantity: '1000',
      sortOrder: 0,
    });

    const [trashed] = await tx
      .insert(recipes)
      .values({
        organizationId: ORG_A,
        name: 'Old recipe',
        deletedAt: new Date(),
      })
      .returning({ id: recipes.id });
    trashedId = trashed!.id;
  });
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

describe('GET /api/recipes/[id]/prep-card/pdf', () => {
  it('lets KITCHEN render the money-free prep card and audits it', async () => {
    h.auth = { orgId: ORG_A, userId: 'kitchen_1', role: 'kitchen' };
    const res = await call(recipeId);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');

    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('%PDF');

    const audited = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select({ action: auditLog.action, entityId: auditLog.entityId })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.organizationId, ORG_A),
            eq(auditLog.action, 'export.recipePrepCardPdf'),
          ),
        ),
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]?.entityId).toBe(recipeId);
  });

  it('lets a MANAGER render it too (no RBAC gate)', async () => {
    h.auth = { orgId: ORG_A, userId: 'manager_1', role: 'manager' };
    const res = await call(recipeId);
    expect(res.status).toBe(200);
  });

  it('renders a scaled card for a valid ?portions=', async () => {
    h.auth = { orgId: ORG_A, userId: 'kitchen_2', role: 'kitchen' };
    const res = await call(recipeId, '?portions=20');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
  });

  it('returns 400 for an invalid ?portions=', async () => {
    h.auth = { orgId: ORG_A, userId: 'kitchen_3', role: 'kitchen' };
    expect((await call(recipeId, '?portions=0')).status).toBe(400);
    expect((await call(recipeId, '?portions=-4')).status).toBe(400);
    expect((await call(recipeId, '?portions=abc')).status).toBe(400);
  });

  it('returns 404 for a trashed recipe', async () => {
    h.auth = { orgId: ORG_A, userId: 'user_1', role: 'kitchen' };
    expect((await call(trashedId)).status).toBe(404);
  });

  it('returns 404 for a recipe id belonging to another org (no audit leak)', async () => {
    h.auth = { orgId: ORG_B, userId: 'user_b', role: 'manager' };
    const res = await call(recipeId);
    expect(res.status).toBe(404);

    const countB = await runInOrg(db, ORG_B, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(auditLog),
    );
    expect(countB[0]?.n).toBe(0);
  });

  it('returns 429 once the documents rate limit is exceeded', async () => {
    const key = rateLimitKey('documents', `${ORG_A}:rl_user`);
    await db.insert(rateLimits).values({ key, windowStart: sql`now()`, count: 20 });

    h.auth = { orgId: ORG_A, userId: 'rl_user', role: 'kitchen' };
    expect((await call(recipeId)).status).toBe(429);
  });
});
