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
 * Integration test for the P&L PDF route (Sprint 3.5B) + the shared loader's
 * cross-tenant isolation. Real handler against PGlite under `tenant_app` (RLS on),
 * with `@/lib/auth`, `@/lib/db` and next-intl stubbed. Proves: kitchen → 403,
 * malformed filter → 400, a manager gets a PDF + an `export.plPdf` audit row in the
 * active org only, the rate limit returns 429, and ORG_A's P&L never includes
 * ORG_B's transactions (and vice-versa).
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

import { GET } from '@/app/api/financials/pl/pdf/route';
import { loadPlDocument } from '@/lib/documents/pl-loader';

let client: PGlite;
let db: TenantDb;

function call(qs: string) {
  return GET(new Request(`http://test/api/financials/pl/pdf${qs}`));
}

async function seedOrg(org: string, income: number, expense: number) {
  await runInOrg(db, org, async (tx) => {
    await tx.insert(organizationSettings).values({
      organizationId: org,
      currency: 'EUR',
      measurementSystem: 'metric',
    });
    const [incCat] = await tx
      .insert(transactionCategories)
      .values({ organizationId: org, slug: 'food_sales', name: 'Food sales', kind: 'income' })
      .returning({ id: transactionCategories.id });
    const [expCat] = await tx
      .insert(transactionCategories)
      .values({ organizationId: org, slug: 'rent', name: 'Rent', kind: 'expense' })
      .returning({ id: transactionCategories.id });
    await tx.insert(transactions).values([
      { organizationId: org, type: 'income', categoryId: incCat!.id, occurredOn: '2026-06-10', amountCents: income },
      { organizationId: org, type: 'expense', categoryId: expCat!.id, occurredOn: '2026-06-12', amountCents: expense },
    ]);
  });
}

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  h.db = db;
  await db.execute(sql.raw('SET ROLE tenant_app;'));
  await seedOrg(ORG_A, 15000, 5000);
  await seedOrg(ORG_B, 99999, 11111);
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

const tCat = (slug: string) => slug;

describe('P&L cross-tenant isolation (loadPlDocument)', () => {
  it('includes only the active org’s transactions', async () => {
    h.auth = { manager: true, orgId: ORG_A, userId: 'user_1' };
    const a = await loadPlDocument({ view: 'month', periodKey: '2026-06', tCat });
    expect(a.incomeCents).toBe(15000);
    expect(a.expenseCents).toBe(5000);

    h.auth = { manager: true, orgId: ORG_B, userId: 'user_b' };
    const b = await loadPlDocument({ view: 'month', periodKey: '2026-06', tCat });
    expect(b.incomeCents).toBe(99999);
    expect(b.expenseCents).toBe(11111);
  });
});

describe('GET /api/financials/pl/pdf', () => {
  it('refuses a kitchen user with 403 (before any data access)', async () => {
    h.auth = { manager: false, orgId: ORG_A, userId: 'kitchen_1' };
    const res = await call('?view=month&period=2026-06');
    expect(res.status).toBe(403);
  });

  it('rejects a malformed filter with 400', async () => {
    h.auth = { manager: true, orgId: ORG_A, userId: 'user_1' };
    const res = await call('?view=month&period=not-a-period');
    expect(res.status).toBe(400);
  });

  it('returns a real PDF for a manager and audits it in the active org only', async () => {
    h.auth = { manager: true, orgId: ORG_A, userId: 'user_1' };
    const res = await call('?view=month&period=2026-06');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');

    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('%PDF');

    const auditedA = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select({ action: auditLog.action, metadata: auditLog.metadata })
        .from(auditLog)
        .where(and(eq(auditLog.organizationId, ORG_A), eq(auditLog.action, 'export.plPdf'))),
    );
    expect(auditedA).toHaveLength(1);

    const countB = await runInOrg(db, ORG_B, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(auditLog),
    );
    expect(countB[0]?.n).toBe(0);
  });

  it('returns 429 once the documents rate limit is exceeded', async () => {
    const key = rateLimitKey('documents', `${ORG_A}:rl_user`);
    await db.insert(rateLimits).values({ key, windowStart: sql`now()`, count: 20 });
    h.auth = { manager: true, orgId: ORG_A, userId: 'rl_user' };
    const res = await call('?view=month&period=2026-06');
    expect(res.status).toBe(429);
  });
});
