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
 * Integration test for the recipe-card PDF route (Sprint 3.5B; MANAGER-ONLY since
 * F4). Runs the real handler against PGlite under the non-privileged `tenant_app`
 * role (RLS enforced), with `@/lib/auth`, `@/lib/db` and next-intl stubbed. Proves:
 * a manager render audits `export.recipeCardPdf` in the active org only, a trashed
 * recipe id → 404, a cross-org id → 404 with no audit leak, and the `documents`
 * rate limit returns 429. (Kitchen → 403 is covered in recipe-card-route-rbac.test.)
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
  canSeeRecipeCosts: (role: string) => role === 'manager',
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

import { GET } from '@/app/api/recipes/[id]/card/pdf/route';

let client: PGlite;
let db: TenantDb;
let recipeId = '';
let trashedId = '';

function call(id: string) {
  return GET(new Request(`http://test/api/recipes/${id}/card/pdf`), {
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

describe('GET /api/recipes/[id]/card/pdf', () => {
  it('lets a manager generate the cost-sheet card and audits it', async () => {
    h.auth = { orgId: ORG_A, userId: 'manager_1', role: 'manager' };
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
            eq(auditLog.action, 'export.recipeCardPdf'),
          ),
        ),
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]?.entityId).toBe(recipeId);
  });

  it('returns 404 for a trashed recipe', async () => {
    h.auth = { orgId: ORG_A, userId: 'user_1', role: 'manager' };
    const res = await call(trashedId);
    expect(res.status).toBe(404);
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

    h.auth = { orgId: ORG_A, userId: 'rl_user', role: 'manager' };
    const res = await call(recipeId);
    expect(res.status).toBe(429);
  });
});
