import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import {
  organizationSettings,
  transactionCategories,
  transactions,
  auditLog,
  rateLimits,
} from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { rateLimitKey } from '@/lib/rate-limit';

/**
 * Integration test for the P&L XLSX route (Sprint 3.5B). Same harness as the PDF
 * route: kitchen → 403, malformed filter → 400, manager → a valid .xlsx (ZIP) +
 * `export.plXlsx` audit in the active org, rate limit → 429.
 */
const ORG_A = 'org_a';

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

import { GET } from '@/app/api/financials/pl/xlsx/route';

let client: PGlite;
let db: TenantDb;

function call(qs: string) {
  return GET(new Request(`http://test/api/financials/pl/xlsx${qs}`));
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
    });
    const [cat] = await tx
      .insert(transactionCategories)
      .values({ organizationId: ORG_A, slug: 'food_sales', name: 'Food sales', kind: 'income' })
      .returning({ id: transactionCategories.id });
    await tx.insert(transactions).values({
      organizationId: ORG_A,
      type: 'income',
      categoryId: cat!.id,
      occurredOn: '2026-06-10',
      amountCents: 15000,
    });
  });
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

describe('GET /api/financials/pl/xlsx', () => {
  it('refuses a kitchen user with 403', async () => {
    h.auth = { manager: false, orgId: ORG_A, userId: 'kitchen_1' };
    expect((await call('?view=month&period=2026-06')).status).toBe(403);
  });

  it('rejects a malformed filter with 400', async () => {
    h.auth = { manager: true, orgId: ORG_A, userId: 'user_1' };
    expect((await call('?view=year&period=2026-13-99')).status).toBe(400);
  });

  it('returns a valid .xlsx for a manager and audits it', async () => {
    h.auth = { manager: true, orgId: ORG_A, userId: 'user_1' };
    const res = await call('?view=month&period=2026-06');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(res.headers.get('content-disposition')).toContain('pl-2026-06.xlsx');

    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const audited = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(and(eq(auditLog.organizationId, ORG_A), eq(auditLog.action, 'export.plXlsx'))),
    );
    expect(audited).toHaveLength(1);
  });

  it('returns 429 once the documents rate limit is exceeded', async () => {
    const key = rateLimitKey('documents', `${ORG_A}:rl_user`);
    await db.insert(rateLimits).values({ key, windowStart: sql`now()`, count: 20 });
    h.auth = { manager: true, orgId: ORG_A, userId: 'rl_user' };
    expect((await call('?view=month&period=2026-06')).status).toBe(429);
  });
});
