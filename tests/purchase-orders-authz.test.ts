import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { purchaseOrders } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { accessibleDescriptors } from '@/lib/search/registry';

/**
 * Sprint 8a RBAC: purchase orders are MANAGER-ONLY. Every PO action returns
 * FORBIDDEN for a kitchen user BEFORE any data access, and the purchaseOrder search
 * descriptor is excluded for kitchen.
 */
const ORG = 'org_po_authz';

const h = vi.hoisted(() => ({
  db: null as unknown as TenantDb,
  org: 'org_po_authz',
  manager: true,
}));

vi.mock('@/lib/auth', () => ({
  getOrgId: vi.fn(async () => h.org),
  isManager: vi.fn(async () => h.manager),
  getUserId: vi.fn(async () => 'user_1'),
  getUserRole: vi.fn(async () => (h.manager ? 'manager' : 'kitchen')),
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
  cancelPurchaseOrderAction,
  createPurchaseOrderAction,
  deletePurchaseOrderAction,
  sendPurchaseOrderAction,
  updatePurchaseOrderAction,
} from '@/app/(app)/purchase-orders/actions';

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

describe('PO actions are manager-only (FORBIDDEN before data)', () => {
  it('kitchen cannot create / update / send / cancel / delete', async () => {
    h.manager = false;

    const create = await createPurchaseOrderAction({
      supplierId: null,
      items: [],
    });
    expect(create.ok).toBe(false);
    if (!create.ok) expect(create.code).toBe('FORBIDDEN');

    for (const res of [
      await updatePurchaseOrderAction('x', { supplierId: null, items: [] }),
      await sendPurchaseOrderAction('x'),
      await cancelPurchaseOrderAction('x'),
      await deletePurchaseOrderAction('x'),
    ]) {
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('FORBIDDEN');
    }

    // No PO row was written by the forbidden create.
    const rows = await runInOrg(h.db, ORG, (tx) =>
      tx.select().from(purchaseOrders).where(eq(purchaseOrders.organizationId, ORG)),
    );
    expect(rows).toHaveLength(0);
  });
});

describe('search registry RBAC', () => {
  it('excludes the purchaseOrder descriptor for kitchen, includes it for manager', () => {
    expect(accessibleDescriptors('kitchen').map((d) => d.type)).not.toContain(
      'purchaseOrder',
    );
    expect(accessibleDescriptors('manager').map((d) => d.type)).toContain(
      'purchaseOrder',
    );
  });
});
