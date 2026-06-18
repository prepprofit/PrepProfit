import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { organizationSettings, employees, shifts, auditLog, rateLimits } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { rateLimitKey } from '@/lib/rate-limit';

/**
 * Integration test for the payroll XLSX route (Sprint 3.5B). kitchen → 403,
 * malformed period → 400, manager → a valid .xlsx (ZIP) + `export.payrollXlsx`
 * audit (counts only) in the active org, rate limit → 429.
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

import { GET } from '@/app/api/payroll/summary/xlsx/route';

let client: PGlite;
let db: TenantDb;

function call(qs: string) {
  return GET(new Request(`http://test/api/payroll/summary/xlsx${qs}`));
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
    const [emp] = await tx
      .insert(employees)
      .values({ organizationId: ORG_A, name: 'Ana', hourlyRateCents: 1200, active: true })
      .returning({ id: employees.id });
    await tx.insert(shifts).values({
      organizationId: ORG_A,
      employeeId: emp!.id,
      startedAt: new Date(Date.UTC(2026, 5, 1, 8, 0)),
      endedAt: new Date(Date.UTC(2026, 5, 1, 16, 0)),
      breakMinutes: 0,
    });
  });
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

describe('GET /api/payroll/summary/xlsx', () => {
  it('refuses a kitchen user with 403', async () => {
    h.auth = { manager: false, orgId: ORG_A, userId: 'kitchen_1' };
    expect((await call('?view=month&d=2026-06-01')).status).toBe(403);
  });

  it('rejects a malformed period with 400', async () => {
    h.auth = { manager: true, orgId: ORG_A, userId: 'user_1' };
    expect((await call('?view=week&d=2026/06/01')).status).toBe(400);
  });

  it('returns a valid .xlsx for a manager and audits it (counts only)', async () => {
    h.auth = { manager: true, orgId: ORG_A, userId: 'user_1' };
    const res = await call('?view=month&d=2026-06-01');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(res.headers.get('content-disposition')).toContain('payroll-2026-06-01.xlsx');

    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const audited = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select({ action: auditLog.action, metadata: auditLog.metadata })
        .from(auditLog)
        .where(
          and(eq(auditLog.organizationId, ORG_A), eq(auditLog.action, 'export.payrollXlsx')),
        ),
    );
    expect(audited).toHaveLength(1);
    expect(JSON.stringify(audited[0]!.metadata)).not.toContain('Ana');
  });

  it('returns 429 once the documents rate limit is exceeded', async () => {
    const key = rateLimitKey('documents', `${ORG_A}:rl_user`);
    await db.insert(rateLimits).values({ key, windowStart: sql`now()`, count: 20 });
    h.auth = { manager: true, orgId: ORG_A, userId: 'rl_user' };
    expect((await call('?view=month&d=2026-06-01')).status).toBe(429);
  });
});
