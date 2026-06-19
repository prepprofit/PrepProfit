import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Sprint 4 (slice 4b) — proves the entitlement controls are WIRED into the
 * Server Actions, not just that the helper works (that's entitlements.test.ts):
 *   - createRecipeAction enforces the plan recipe cap (PLAN_LIMIT_REACHED) inside
 *     the same withOrg transaction as the count + insert.
 *   - paid-module actions (invoices Pro+, payroll Business) return UPGRADE_REQUIRED
 *     BEFORE any data access when the plan lacks the feature.
 * The auth + entitlements + db layers are mocked so this stays a fast unit test.
 */
const h = vi.hoisted(() => ({
  manager: true,
  recipeCount: 0,
  limitAllowed: true,
  featureDenied: null as null | 'UPGRADE_REQUIRED',
  withOrgCalls: 0,
}));

vi.mock('@/lib/auth', () => ({
  isManager: vi.fn(async () => h.manager),
  getOrgId: vi.fn(async () => 'org_test'),
}));

vi.mock('@/lib/entitlements', () => ({
  assertPlanLimit: vi.fn(async () => ({
    allowed: h.limitAllowed,
    limit: 50,
    tier: 'starter' as const,
  })),
  requireFeature: vi.fn(async () => h.featureDenied),
}));

vi.mock('@/lib/db', () => ({
  withOrg: (_org: string, fn: (tx: unknown) => unknown) => {
    h.withOrgCalls += 1;
    return fn({});
  },
}));

vi.mock('@/lib/data/recipes', () => ({
  countActiveRecipes: vi.fn(async () => h.recipeCount),
  createRecipe: vi.fn(async () => ({ id: 'recipe_1', name: 'Sourdough' })),
  softDeleteRecipe: vi.fn(),
  updateRecipe: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { createRecipeAction } from '@/app/(app)/recipes/actions';
import { createInvoiceAction } from '@/app/(app)/invoices/actions';
import { createEmployeeAction } from '@/app/(app)/payroll/actions';

const validRecipe = {
  name: 'Sourdough',
  yieldPortions: 10,
  yieldPercentage: 90,
  laborCostCents: 0,
  energyCostCents: 0,
  packagingCostCents: 0,
};

afterEach(() => {
  h.manager = true;
  h.recipeCount = 0;
  h.limitAllowed = true;
  h.featureDenied = null;
  h.withOrgCalls = 0;
  vi.clearAllMocks();
});

describe('createRecipeAction — plan recipe cap', () => {
  it('creates the recipe when under the cap', async () => {
    h.recipeCount = 49;
    h.limitAllowed = true;
    const res = await createRecipeAction(validRecipe);
    expect(res.ok).toBe(true);
  });

  it('returns PLAN_LIMIT_REACHED at the cap (no insert)', async () => {
    h.recipeCount = 50;
    h.limitAllowed = false;
    const res = await createRecipeAction(validRecipe);
    expect(res).toEqual({ ok: false, code: 'PLAN_LIMIT_REACHED' });
    // The count + cap check + insert all share the one withOrg transaction.
    expect(h.withOrgCalls).toBe(1);
  });

  it('validates input before the cap (INVALID_INPUT, never touches the db)', async () => {
    h.limitAllowed = false;
    const res = await createRecipeAction({ name: '' });
    expect(res).toEqual({ ok: false, code: 'INVALID_INPUT' });
    expect(h.withOrgCalls).toBe(0);
  });
});

describe('paid-module actions — feature gate', () => {
  it('invoices: UPGRADE_REQUIRED before any data access', async () => {
    h.featureDenied = 'UPGRADE_REQUIRED';
    const res = await createInvoiceAction({});
    expect(res).toEqual({ ok: false, code: 'UPGRADE_REQUIRED' });
    expect(h.withOrgCalls).toBe(0);
  });

  it('payroll: UPGRADE_REQUIRED before any data access', async () => {
    h.featureDenied = 'UPGRADE_REQUIRED';
    const res = await createEmployeeAction({});
    expect(res).toEqual({ ok: false, code: 'UPGRADE_REQUIRED' });
    expect(h.withOrgCalls).toBe(0);
  });

  it('FORBIDDEN (RBAC) is checked before the feature gate', async () => {
    h.manager = false;
    h.featureDenied = 'UPGRADE_REQUIRED';
    const res = await createInvoiceAction({});
    expect(res).toEqual({ ok: false, code: 'FORBIDDEN' });
  });
});
