import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import {
  organizationSettings,
  purchaseOrders,
  purchaseOrderItems,
  auditLog,
  rateLimits,
} from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { rateLimitKey } from '@/lib/rate-limit';

/**
 * Integration test for the PO PDF route (Sprint 8a). Real handler against PGlite
 * under `tenant_app` (RLS enforced), with auth/db/next-intl stubbed. Proves:
 * kitchen → 403, cross-org id → 404, manager → real PDF + `export.purchaseOrderPdf`
 * audit in the active org only, and the `documents` rate limit → 429. POs are NOT
 * plan-gated, so there is no 402.
 */
const ORG_A = 'org_a';
const ORG_B = 'org_b';

const h = vi.hoisted(() => ({
  db: null as unknown,
  auth: { manager: true, orgId: 'org_a', userId: 'user_1' },
}));

vi.mock('@/lib/auth', () => ({
  isManager: vi.fn(async () => h.auth.manager),
  getOrgId: vi.fn(async () => h.auth.orgId),
  getUserId: vi.fn(async () => h.auth.userId),
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

import { GET } from '@/app/api/purchase-orders/[id]/pdf/route';

let client: PGlite;
let db: TenantDb;
let poId = '';

function call(id: string) {
  return GET(new Request(`http://test/api/purchase-orders/${id}/pdf`), {
    params: Promise.resolve({ id }),
  });
}

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  h.db = db;
  await db.execute(sql.raw('SET ROLE tenant_app;'));

  // Seed a SENT PO (frozen snapshot) + one line + settings in ORG_A.
  await runInOrg(db, ORG_A, async (tx) => {
    await tx.insert(organizationSettings).values({
      organizationId: ORG_A,
      currency: 'EUR',
      measurementSystem: 'metric',
      businessName: 'Padaria do Bairro',
    });
    const [po] = await tx
      .insert(purchaseOrders)
      .values({
        organizationId: ORG_A,
        number: 7,
        currencyCode: 'EUR',
        status: 'sent',
        orderDate: '2026-06-22',
        supplierName: 'ACME Foods',
        supplierEmail: 'orders@acme.test',
        subtotalCents: 1500,
        totalCents: 1500,
      })
      .returning({ id: purchaseOrders.id });
    poId = po!.id;
    await tx.insert(purchaseOrderItems).values({
      organizationId: ORG_A,
      purchaseOrderId: poId,
      ingredientName: 'Sugar',
      dimension: 'weight',
      quantity: '10000',
      unitCostCents: 150,
      lineTotalCents: 1500,
      sortOrder: 0,
    });
  });
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

describe('GET /api/purchase-orders/[id]/pdf', () => {
  it('refuses a kitchen user with 403 (before any data access)', async () => {
    h.auth = { manager: false, orgId: ORG_A, userId: 'kitchen_1' };
    expect((await call(poId)).status).toBe(403);
  });

  it('returns 404 for a PO id belonging to another org', async () => {
    h.auth = { manager: true, orgId: ORG_B, userId: 'user_b' };
    expect((await call(poId)).status).toBe(404);

    const countB = await runInOrg(db, ORG_B, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(auditLog),
    );
    expect(countB[0]?.n).toBe(0);
  });

  it('returns a real PDF for a manager and audits it in the active org', async () => {
    h.auth = { manager: true, orgId: ORG_A, userId: 'user_1' };
    const res = await call(poId);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('PO-0007.pdf');

    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('%PDF');

    const audited = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select({ action: auditLog.action, entityId: auditLog.entityId })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.organizationId, ORG_A),
            eq(auditLog.action, 'export.purchaseOrderPdf'),
          ),
        ),
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]?.entityId).toBe(poId);
  });

  it('returns 429 once the documents rate limit is exceeded', async () => {
    const key = rateLimitKey('documents', `${ORG_A}:rl_user`);
    await db.insert(rateLimits).values({ key, windowStart: sql`now()`, count: 20 });

    h.auth = { manager: true, orgId: ORG_A, userId: 'rl_user' };
    expect((await call(poId)).status).toBe(429);
  });
});
