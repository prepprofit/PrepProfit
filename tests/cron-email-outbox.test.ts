import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import {
  auditLog,
  emailOutbox,
  organizationSettings,
  purchaseOrders,
  purchaseOrderItems,
} from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';

/**
 * Integration test for the email-outbox cron worker (Sprint 8a). Real handler
 * against PGlite under `tenant_app`, with Clerk/env/rate-limit/sender stubbed.
 * Proves: 401 without the secret, 429 over the limit, no-op when email is
 * unconfigured, a pending row is delivered (provider idempotency key passed) +
 * `document.email` audited only after accept, and an idempotent re-run never resends.
 */
const ORG_A = 'org_a';

const h = vi.hoisted(() => ({
  db: null as unknown,
  emailOn: true,
  rateLimited: false,
  send: vi.fn(async (_input: unknown) => ({ id: 'provider-msg-1' })),
}));

vi.mock('@/lib/cron-auth', () => ({
  isCronAuthorized: (header: string | null, secret: string) =>
    !!secret && header === `Bearer ${secret}`,
}));

vi.mock('@/lib/env', () => ({
  serverEnv: () => ({ CRON_SECRET: 'secret' }),
  isEmailConfigured: () => h.emailOn,
}));

vi.mock('@/lib/rate-limit', () => ({
  enforceRateLimit: vi.fn(async () => ({ allowed: !h.rateLimited })),
}));

vi.mock('@clerk/nextjs/server', () => ({
  clerkClient: async () => ({
    organizations: {
      getOrganizationList: async () => ({
        data: [{ id: ORG_A, name: 'Org A' }],
        totalCount: 1,
      }),
    },
  }),
}));

vi.mock('@/lib/email/resend', () => ({
  getEmailSender: () => ({ send: h.send }),
}));

vi.mock('@/lib/documents/logo', () => ({ loadSafeLogo: async () => null }));

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));

vi.mock('@/lib/db', () => ({
  getDb: () => h.db,
  withOrg: async (org: string, fn: (tx: unknown) => unknown) => {
    const { runInOrg: rio } = await import('@/lib/db/tenant');
    return rio(h.db as TenantDb, org, fn as never);
  },
}));

import { GET } from '@/app/api/cron/process-email-outbox/route';

let client: PGlite;
let db: TenantDb;
let poId = '';

const callWith = (header: string | null) =>
  GET(
    new Request('http://test/api/cron/process-email-outbox', {
      headers: header ? { authorization: header } : {},
    }),
  );

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
      businessName: 'Padaria',
    });
    const [po] = await tx
      .insert(purchaseOrders)
      .values({
        organizationId: ORG_A,
        number: 1,
        currencyCode: 'EUR',
        status: 'sent',
        orderDate: '2026-06-22',
        supplierName: 'ACME',
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
    await tx.insert(emailOutbox).values({
      organizationId: ORG_A,
      documentType: 'purchase_order',
      documentId: poId,
      toEmail: 'orders@acme.test',
      dedupKey: `purchase_order:${poId}:send`,
    });
  });
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

beforeEach(() => {
  h.emailOn = true;
  h.rateLimited = false;
  h.send.mockClear();
});

describe('GET /api/cron/process-email-outbox', () => {
  it('401 without the cron secret', async () => {
    expect((await callWith(null)).status).toBe(401);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('429 when rate limited', async () => {
    h.rateLimited = true;
    expect((await callWith('Bearer secret')).status).toBe(429);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('no-op when email is not configured', async () => {
    h.emailOn = false;
    const res = await callWith('Bearer secret');
    expect(res.status).toBe(200);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('delivers a pending row, passes the idempotency key, audits after accept', async () => {
    const res = await callWith('Bearer secret');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; sent: number };
    expect(body.processed).toBe(1);
    expect(body.sent).toBe(1);

    expect(h.send).toHaveBeenCalledTimes(1);
    const arg = h.send.mock.calls[0]![0] as {
      to: string;
      idempotencyKey: string;
      attachments: unknown[];
    };
    expect(arg.to).toBe('orders@acme.test');
    expect(arg.idempotencyKey).toBe(`purchase_order:${poId}:send`);
    expect(arg.attachments).toHaveLength(1);

    const row = await runInOrg(db, ORG_A, (tx) =>
      tx.select().from(emailOutbox).where(eq(emailOutbox.documentId, poId)),
    );
    expect(row[0]?.status).toBe('sent');
    expect(row[0]?.providerMessageId).toBe('provider-msg-1');

    const audited = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(
          and(eq(auditLog.organizationId, ORG_A), eq(auditLog.action, 'document.email')),
        ),
    );
    expect(audited[0]?.n).toBe(1);
  });

  it('re-run never resends a row that already has a provider message id', async () => {
    const res = await callWith('Bearer secret');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number };
    expect(body.processed).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
  });
});
