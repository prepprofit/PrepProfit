import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { auditLog, organizationSettings } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';

/**
 * Integration test for updateOrgSettingsAction, focused on the weekly-CFO toggle
 * added in the React Email migration. Proves: a manager can enable it and it
 * persists; the audit metadata records the BOOLEAN only (never the email address);
 * and a kitchen user is refused with FORBIDDEN before any write. PGlite under
 * `tenant_app`; auth + next/cache stubbed.
 */
const ORG = 'org_settings';

const h = vi.hoisted(() => ({
  db: null as unknown,
  manager: true,
}));

vi.mock('@/lib/auth', () => ({
  isManager: vi.fn(async () => h.manager),
  getOrgId: vi.fn(async () => ORG),
}));

vi.mock('@/lib/data/audit', async (orig) => ({
  ...(await orig<typeof import('@/lib/data/audit')>()),
  auditActor: vi.fn(async () => ({
    userId: 'user_1',
    role: 'manager' as const,
    requestId: 'req_1',
  })),
}));

vi.mock('@/lib/db', () => ({
  getDb: () => h.db,
  withOrg: async (org: string, fn: (tx: unknown) => unknown) => {
    const { runInOrg: rio } = await import('@/lib/db/tenant');
    return rio(h.db as TenantDb, org, fn as never);
  },
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { updateOrgSettingsAction } from '@/app/(app)/settings/actions';

let client: PGlite;
let db: TenantDb;

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  h.db = db;
  await db.execute(sql.raw('SET ROLE tenant_app;'));
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

beforeEach(() => {
  h.manager = true;
});

describe('updateOrgSettingsAction — weekly CFO toggle', () => {
  it('lets a manager enable the report and persists it', async () => {
    const res = await updateOrgSettingsAction(
      null,
      form({
        currency: 'EUR',
        measurementSystem: 'metric',
        businessEmail: 'owner@test.example',
        weeklyCfoReportEmailEnabled: 'on',
      }),
    );
    expect(res).toEqual({ ok: true, data: undefined });

    const row = await runInOrg(db, ORG, (tx) =>
      tx.select().from(organizationSettings).where(eq(organizationSettings.organizationId, ORG)),
    );
    expect(row[0]!.weeklyCfoReportEmailEnabled).toBe(true);
  });

  it('audits the toggle as a boolean only — never the email address', async () => {
    const audited = await runInOrg(db, ORG, (tx) =>
      tx
        .select({ metadata: auditLog.metadata })
        .from(auditLog)
        .where(and(eq(auditLog.organizationId, ORG), eq(auditLog.action, 'settings.update'))),
    );
    expect(audited.length).toBeGreaterThan(0);
    const meta = audited[audited.length - 1]!.metadata as Record<string, unknown>;
    expect(meta.weeklyCfoReportEmailEnabled).toBe(true);
    expect(JSON.stringify(meta)).not.toContain('owner@test.example');
  });

  it('refuses a kitchen user with FORBIDDEN before any write', async () => {
    h.manager = false;
    const res = await updateOrgSettingsAction(
      null,
      form({
        currency: 'USD',
        measurementSystem: 'metric',
        weeklyCfoReportEmailEnabled: 'on',
      }),
    );
    expect(res).toEqual({ ok: false, code: 'FORBIDDEN' });
    // Currency was NOT changed to USD (no write happened).
    const row = await runInOrg(db, ORG, (tx) =>
      tx.select().from(organizationSettings).where(eq(organizationSettings.organizationId, ORG)),
    );
    expect(row[0]!.currency).toBe('EUR');
  });
});
