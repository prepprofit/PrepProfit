import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import {
  organizationSettings,
  invoices,
  invoiceItems,
  auditLog,
  rateLimits,
} from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { rateLimitKey } from '@/lib/rate-limit';

/**
 * Integration test for the invoice PDF route (Sprint 3.5A). Runs the real handler
 * against PGlite under the non-privileged `tenant_app` role (so RLS is enforced),
 * with `@/lib/auth`, `@/lib/db` and next-intl stubbed. Proves: kitchen → 403,
 * cross-org id → 404, a manager gets a real PDF + an `export.invoicePdf` audit row
 * in the active org only, and the `documents` rate limit returns 429.
 */
const ORG_A = 'org_a';
const ORG_B = 'org_b';

// Mutable auth/db state shared with the hoisted mocks.
const h = vi.hoisted(() => ({
  db: null as unknown,
  auth: { manager: true, orgId: 'org_a', userId: 'user_1' } as {
    manager: boolean;
    orgId: string;
    userId: string;
    feature?: boolean;
  },
}));

vi.mock('@/lib/auth', () => ({
  isManager: vi.fn(async () => h.auth.manager),
  getOrgId: vi.fn(async () => h.auth.orgId),
  getUserId: vi.fn(async () => h.auth.userId),
  getOrgName: vi.fn(async () => 'Test Org'),
}));

// Plan gate (Sprint 4): allowed unless a test sets `feature: false`.
vi.mock('@/lib/entitlements', () => ({
  canUseFeature: vi.fn(async () => h.auth.feature !== false),
}));

vi.mock('@/lib/db', () => ({
  getDb: () => h.db,
  withOrg: async (org: string, fn: (tx: unknown) => unknown) => {
    const { runInOrg: rio } = await import('@/lib/db/tenant');
    return rio(h.db as TenantDb, org, fn as never);
  },
}));

// next-intl getTranslations needs a request scope we don't have in a unit test;
// an identity translator returns each key verbatim (fine for rendering).
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));

// Import the route AFTER the mocks are registered.
import { GET } from '@/app/api/invoices/[id]/pdf/route';

let client: PGlite;
let db: TenantDb;
let invoiceId = '';

function call(id: string) {
  return GET(new Request(`http://test/api/invoices/${id}/pdf`), {
    params: Promise.resolve({ id }),
  });
}

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  h.db = db;
  await db.execute(sql.raw('SET ROLE tenant_app;'));

  // Seed an issued invoice (+ one line + settings) in ORG_A.
  await runInOrg(db, ORG_A, async (tx) => {
    await tx.insert(organizationSettings).values({
      organizationId: ORG_A,
      currency: 'EUR',
      measurementSystem: 'metric',
      businessName: 'Padaria do Bairro',
    });
    const [inv] = await tx
      .insert(invoices)
      .values({
        organizationId: ORG_A,
        status: 'issued',
        number: 'INV-2026-0001',
        seq: 1,
        year: 2026,
        issueDate: '2026-06-18',
        dueDate: '2026-07-18',
        customerName: 'Café Lisboa',
        customerTaxId: 'PT123456789',
        subtotalCents: 3500,
        taxCents: 805,
        totalCents: 4305,
      })
      .returning({ id: invoices.id });
    invoiceId = inv!.id;
    await tx.insert(invoiceItems).values({
      organizationId: ORG_A,
      invoiceId: invoiceId,
      description: 'Sourdough loaf',
      quantity: '10',
      unitPriceCents: 350,
      taxRate: '23',
      sortOrder: 0,
    });
  });
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

describe('GET /api/invoices/[id]/pdf', () => {
  it('refuses a kitchen user with 403 (before any data access)', async () => {
    h.auth = { manager: false, orgId: ORG_A, userId: 'kitchen_1' };
    const res = await call(invoiceId);
    expect(res.status).toBe(403);
  });

  it('returns 402 when the plan lacks the invoices feature', async () => {
    h.auth = { manager: true, orgId: ORG_A, userId: 'user_1', feature: false };
    const res = await call(invoiceId);
    expect(res.status).toBe(402);
  });

  it('returns 404 for an invoice id belonging to another org', async () => {
    h.auth = { manager: true, orgId: ORG_B, userId: 'user_b' };
    const res = await call(invoiceId);
    expect(res.status).toBe(404);

    // No audit event leaked into ORG_B.
    const countB = await runInOrg(db, ORG_B, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(auditLog),
    );
    expect(countB[0]?.n).toBe(0);
  });

  it('returns a real PDF for a manager and audits it in the active org', async () => {
    h.auth = { manager: true, orgId: ORG_A, userId: 'user_1' };
    const res = await call(invoiceId);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('INV-2026-0001.pdf');

    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('%PDF');

    const audited = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select({ action: auditLog.action, entityId: auditLog.entityId })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.organizationId, ORG_A),
            eq(auditLog.action, 'export.invoicePdf'),
          ),
        ),
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]?.entityId).toBe(invoiceId);
  });

  it('returns 429 once the documents rate limit is exceeded', async () => {
    // Pre-fill the fixed-window counter to the limit for this scope so the next
    // hit trips immediately (no need to render 20 PDFs).
    const key = rateLimitKey('documents', `${ORG_A}:rl_user`);
    await db
      .insert(rateLimits)
      .values({ key, windowStart: sql`now()`, count: 20 });

    h.auth = { manager: true, orgId: ORG_A, userId: 'rl_user' };
    const res = await call(invoiceId);
    expect(res.status).toBe(429);
  });
});
