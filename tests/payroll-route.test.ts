import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { organizationSettings, employees, shifts, auditLog, rateLimits } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { rateLimitKey } from '@/lib/rate-limit';

/**
 * Integration test for the payroll-summary PDF route (Sprint 3.5B) + the shared
 * loader's cross-tenant isolation. Proves: kitchen → 403, malformed period → 400, a
 * manager gets a PDF + an `export.payrollPdf` audit row whose metadata is COUNTS
 * ONLY (no names, no per-person pay), the rate limit returns 429, and ORG_A's
 * summary never includes ORG_B's employees/shifts.
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

import { GET } from '@/app/api/payroll/summary/pdf/route';
import { loadPayrollDocument } from '@/lib/documents/payroll-loader';

let client: PGlite;
let db: TenantDb;

function call(qs: string) {
  return GET(new Request(`http://test/api/payroll/summary/pdf${qs}`));
}

async function seedOrg(org: string, name: string, rate: number) {
  await runInOrg(db, org, async (tx) => {
    await tx.insert(organizationSettings).values({
      organizationId: org,
      currency: 'EUR',
      measurementSystem: 'metric',
    });
    const [emp] = await tx
      .insert(employees)
      .values({ organizationId: org, name, hourlyRateCents: rate, active: true })
      .returning({ id: employees.id });
    // One closed 8h shift on 2026-06-01.
    await tx.insert(shifts).values({
      organizationId: org,
      employeeId: emp!.id,
      startedAt: new Date(Date.UTC(2026, 5, 1, 8, 0)),
      endedAt: new Date(Date.UTC(2026, 5, 1, 16, 0)),
      breakMinutes: 0,
    });
  });
}

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  h.db = db;
  await db.execute(sql.raw('SET ROLE tenant_app;'));
  await seedOrg(ORG_A, 'Ana', 1200);
  await seedOrg(ORG_B, 'Zara', 9999);
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

describe('payroll cross-tenant isolation (loadPayrollDocument)', () => {
  it('includes only the active org’s employees/shifts', async () => {
    h.auth = { manager: true, orgId: ORG_A, userId: 'user_1' };
    const a = await loadPayrollDocument({ view: 'month', anchor: '2026-06-01' });
    expect(a.rows.map((r) => r.name)).toEqual(['Ana']);
    expect(a.totalPayCents).toBe(9600); // 8h * 1200

    h.auth = { manager: true, orgId: ORG_B, userId: 'user_b' };
    const b = await loadPayrollDocument({ view: 'month', anchor: '2026-06-01' });
    expect(b.rows.map((r) => r.name)).toEqual(['Zara']);
  });
});

describe('GET /api/payroll/summary/pdf', () => {
  it('refuses a kitchen user with 403', async () => {
    h.auth = { manager: false, orgId: ORG_A, userId: 'kitchen_1' };
    expect((await call('?view=month&d=2026-06-01')).status).toBe(403);
  });

  it('rejects a malformed period with 400', async () => {
    h.auth = { manager: true, orgId: ORG_A, userId: 'user_1' };
    expect((await call('?view=month&d=June')).status).toBe(400);
  });

  it('returns a PDF and audits counts only (no PII)', async () => {
    h.auth = { manager: true, orgId: ORG_A, userId: 'user_1' };
    const res = await call('?view=month&d=2026-06-01');
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('%PDF');

    const audited = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select({ metadata: auditLog.metadata })
        .from(auditLog)
        .where(and(eq(auditLog.organizationId, ORG_A), eq(auditLog.action, 'export.payrollPdf'))),
    );
    expect(audited).toHaveLength(1);
    const meta = audited[0]!.metadata as Record<string, unknown>;
    expect(meta).toEqual({
      view: 'month',
      anchor: '2026-06-01',
      employeeCount: 1,
      shiftCount: 1,
    });
    // PII guard: the serialized metadata must contain no name or pay amount.
    const json = JSON.stringify(meta);
    expect(json).not.toContain('Ana');
    expect(json).not.toContain('9600');

    const countB = await runInOrg(db, ORG_B, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(auditLog),
    );
    expect(countB[0]?.n).toBe(0);
  });

  it('returns 429 once the documents rate limit is exceeded', async () => {
    const key = rateLimitKey('documents', `${ORG_A}:rl_user`);
    await db.insert(rateLimits).values({ key, windowStart: sql`now()`, count: 20 });
    h.auth = { manager: true, orgId: ORG_A, userId: 'rl_user' };
    expect((await call('?view=month&d=2026-06-01')).status).toBe(429);
  });
});
