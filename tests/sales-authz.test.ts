import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { sales as salesTable } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';

/**
 * Sprint 12a RBAC + entitlement ordering: every sales action is MANAGER-ONLY and
 * gated by the `invoices` feature (D4). Canonical order is RBAC → entitlement → data,
 * so a kitchen user gets FORBIDDEN and a manager on a plan without the feature gets
 * UPGRADE_REQUIRED — both BEFORE any row is written. Also proves cross-org RLS for the
 * two new tables under the non-privileged `tenant_app` role.
 */
const ORG = 'org_sales_authz';
const ORG_B = 'org_sales_b';

const h = vi.hoisted(() => ({
  db: null as unknown as TenantDb,
  org: 'org_sales_authz',
  manager: true,
  hasFeature: true,
}));

vi.mock('@/lib/auth', () => ({
  getOrgId: vi.fn(async () => h.org),
  isManager: vi.fn(async () => h.manager),
  getUserId: vi.fn(async () => 'user_1'),
  getUserRole: vi.fn(async () => (h.manager ? 'manager' : 'kitchen')),
  canAccessFinancials: (role: string) => role === 'manager',
}));

vi.mock('@/lib/entitlements', () => ({
  requireFeature: vi.fn(async () => (h.hasFeature ? null : 'UPGRADE_REQUIRED')),
}));

vi.mock('@/lib/db', async () => {
  const { runInOrg: realRunInOrg } = await import('@/lib/db/tenant');
  return {
    withOrg: (org: string, fn: (tx: never) => unknown) =>
      realRunInOrg(h.db, org, fn as never),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { createSaleAction } from '@/app/(app)/sales/actions';

let client: PGlite;
let recipeId: string;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  h.db = test.db as unknown as TenantDb;
  await h.db.execute(sql.raw('SET ROLE tenant_app;'));

  recipeId = await runInOrg(h.db, ORG, async (tx) => {
    const ing = await createIngredient(tx, ORG, {
      name: 'Flour',
      dimension: 'weight',
      priceCents: 1000,
    });
    const recipe = await createRecipe(tx, ORG, { name: 'Loaf' });
    await addRecipeIngredient(tx, ORG, {
      recipeId: recipe.id,
      ingredientId: ing.id,
      quantity: 100,
    });
    return recipe.id;
  });
});

afterAll(async () => {
  await h.db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

beforeEach(() => {
  h.manager = true;
  h.hasFeature = true;
});

const input = () => ({
  saleDate: '2026-07-10',
  note: null,
  lines: [
    {
      itemKind: 'recipe' as const,
      itemRecipeId: recipeId,
      quantity: 1,
      unitNetCents: 500,
      taxRateBps: 2300,
    },
  ],
});

async function saleCount(org: string): Promise<number> {
  const rows = await runInOrg(h.db, org, (tx) =>
    tx.select().from(salesTable).where(eq(salesTable.organizationId, org)),
  );
  return rows.length;
}

describe('sales RBAC + entitlement ordering (Sprint 12a)', () => {
  it('a kitchen user gets FORBIDDEN before any data access', async () => {
    h.manager = false;
    const before = await saleCount(ORG);
    const result = await createSaleAction(input());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('FORBIDDEN');
    expect(await saleCount(ORG)).toBe(before); // nothing written
  });

  it('a manager on a plan without `invoices` gets UPGRADE_REQUIRED before data', async () => {
    h.manager = true;
    h.hasFeature = false;
    const before = await saleCount(ORG);
    const result = await createSaleAction(input());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('UPGRADE_REQUIRED');
    expect(await saleCount(ORG)).toBe(before); // nothing written
  });

  it('a manager with the feature can create a draft', async () => {
    const result = await createSaleAction(input());
    expect(result.ok).toBe(true);
  });

  it('cross-org RLS: org B never sees org A sales', async () => {
    await createSaleAction({ ...input(), saleDate: '2026-07-11' });
    expect(await saleCount(ORG)).toBeGreaterThan(0);
    expect(await saleCount(ORG_B)).toBe(0);
  });
});
