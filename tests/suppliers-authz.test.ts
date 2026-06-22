import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { ingredientSuppliers, suppliers } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { createIngredient, getIngredientById } from '@/lib/data/ingredients';
import { accessibleDescriptors } from '@/lib/search/registry';

/**
 * Sprint 7 RBAC: suppliers are MANAGER-ONLY. Every supplier action +
 * setIngredientSupplierAction returns FORBIDDEN for kitchen BEFORE any data access;
 * the kitchen ingredient edit ignores a forged `supplier` field (§12.3); the
 * supplier search descriptor is excluded for kitchen.
 */
const ORG = 'org_supplier_authz';

const h = vi.hoisted(() => ({
  db: null as unknown as TenantDb,
  org: 'org_supplier_authz',
  manager: true,
}));

vi.mock('@/lib/auth', () => ({
  getOrgId: vi.fn(async () => h.org),
  isManager: vi.fn(async () => h.manager),
  getUserId: vi.fn(async () => 'user_1'),
  getUserRole: vi.fn(async () => (h.manager ? 'manager' : 'kitchen')),
  // Pure predicate used by the search registry (imported transitively).
  canAccessFinancials: (role: string) => role === 'manager',
}));

vi.mock('@/lib/db', async () => {
  const { runInOrg: realRunInOrg } = await import('@/lib/db/tenant');
  return {
    withOrg: (org: string, fn: (tx: never) => unknown) =>
      realRunInOrg(h.db, org, fn as never),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  archiveSupplierAction,
  createSupplierAction,
  reactivateSupplierAction,
  updateSupplierAction,
} from '@/app/(app)/suppliers/actions';
import {
  setIngredientSupplierAction,
  updateIngredientAction,
} from '@/app/(app)/ingredients/actions';

let client: PGlite;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  h.db = test.db as unknown as TenantDb;
  await h.db.execute(sql.raw('SET ROLE tenant_app;'));
});

afterAll(async () => {
  await h.db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

const supplierInput = (name: string) => ({
  name,
  email: null,
  phone: null,
  address: null,
  taxId: null,
  notes: null,
});

describe('supplier actions are manager-only (FORBIDDEN before data)', () => {
  it('kitchen cannot create / update / archive / reactivate a supplier', async () => {
    h.manager = false;
    expect((await createSupplierAction(supplierInput('Sneaky Co'))).ok).toBe(false);
    expect((await updateSupplierAction('x', supplierInput('Sneaky Co'))).ok).toBe(false);
    expect((await archiveSupplierAction('x')).ok).toBe(false);
    expect((await reactivateSupplierAction('x')).ok).toBe(false);

    // No supplier row was written.
    const rows = await runInOrg(h.db, ORG, (tx) =>
      tx.select().from(suppliers).where(eq(suppliers.organizationId, ORG)),
    );
    expect(rows).toHaveLength(0);

    const res = await createSupplierAction(supplierInput('Sneaky Co'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('FORBIDDEN');
  });

  it('kitchen cannot set an ingredient supplier (FORBIDDEN, no link)', async () => {
    h.manager = true;
    const ing = await runInOrg(h.db, ORG, (tx) =>
      createIngredient(tx, ORG, { name: 'Guarded', dimension: 'weight', priceCents: 0 }),
    );

    h.manager = false;
    const res = await setIngredientSupplierAction(ing.id, { supplierName: 'Nope Co' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('FORBIDDEN');

    const links = await runInOrg(h.db, ORG, (tx) =>
      tx
        .select()
        .from(ingredientSuppliers)
        .where(eq(ingredientSuppliers.ingredientId, ing.id)),
    );
    expect(links).toHaveLength(0);
  });
});

describe('forged supplier field is ignored on ingredient edit (§12.3)', () => {
  it('a kitchen edit carrying `supplier` does not change the stored supplier', async () => {
    h.manager = true;
    const ing = await runInOrg(h.db, ORG, (tx) =>
      createIngredient(tx, ORG, { name: 'NoSupplier', dimension: 'weight', priceCents: 0 }),
    );

    h.manager = false;
    const res = await updateIngredientAction(ing.id, {
      name: 'NoSupplier',
      dimension: 'weight',
      supplier: 'Injected Co', // forged — schema strips it
    });
    expect(res.ok).toBe(true);

    const refreshed = await runInOrg(h.db, ORG, (tx) =>
      getIngredientById(tx, ORG, ing.id),
    );
    expect(refreshed?.supplier).toBeNull();
  });
});

describe('search registry RBAC', () => {
  it('excludes the supplier descriptor for kitchen, includes it for manager', () => {
    const kitchen = accessibleDescriptors('kitchen').map((d) => d.type);
    expect(kitchen).not.toContain('supplier');
    const manager = accessibleDescriptors('manager').map((d) => d.type);
    expect(manager).toContain('supplier');
  });
});
