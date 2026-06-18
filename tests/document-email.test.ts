import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { organizationSettings, invoices, invoiceItems, auditLog, rateLimits } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { rateLimitKey } from '@/lib/rate-limit';

/**
 * Integration test for the document-email Server Action (Sprint 3.5C). Proves the
 * canonical order and the safety properties: kitchen → FORBIDDEN, an invalid
 * recipient → INVALID_INPUT (no send), the `documentEmail` rate limit → RATE_LIMITED,
 * a happy path that sends EXACTLY ONCE with a `%PDF` attachment + records a PII-free
 * `document.email` audit row only AFTER acceptance, a provider failure → EMAIL_FAILED
 * with ZERO audit rows, and a cross-tenant invoice id → NOT_FOUND with no send (no
 * other org's document is ever attached). The provider is always mocked — nothing is
 * ever actually sent.
 */
const ORG_A = 'org_a';
const ORG_B = 'org_b';

const h = vi.hoisted(() => ({
  db: null as unknown,
  auth: { manager: true, orgId: 'org_a', userId: 'user_1' },
  email: { calls: [] as { to: string; subject: string; attachments: { filename: string; content: Buffer }[] }[], throwError: false },
}));

vi.mock('@/lib/auth', () => ({
  isManager: vi.fn(async () => h.auth.manager),
  getOrgId: vi.fn(async () => h.auth.orgId),
  getUserId: vi.fn(async () => h.auth.userId),
  getOrgName: vi.fn(async () => 'Test Org'),
  getUserRole: vi.fn(async () => (h.auth.manager ? 'manager' : 'kitchen')),
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

vi.mock('@/lib/email/resend', () => ({
  getEmailSender: () => ({
    send: async (input: { to: string; subject: string; attachments: { filename: string; content: Buffer }[] }) => {
      h.email.calls.push(input);
      if (h.email.throwError) throw new Error('provider rejected');
      return { id: 'msg_test_123' };
    },
  }),
}));

import { emailDocumentAction } from '@/app/(app)/documents/email-actions';

let client: PGlite;
let db: TenantDb;
let invoiceA = '';
let invoiceB = '';

async function seedOrgInvoice(org: string, number: string): Promise<string> {
  return runInOrg(db, org, async (tx) => {
    await tx.insert(organizationSettings).values({
      organizationId: org,
      currency: 'EUR',
      measurementSystem: 'metric',
      businessName: `Biz ${org}`,
    });
    const [inv] = await tx
      .insert(invoices)
      .values({
        organizationId: org,
        status: 'issued',
        number,
        customerName: 'Acme Co',
        customerEmail: 'acme@example.com',
        subtotalCents: 10000,
        taxCents: 2300,
        totalCents: 12300,
      })
      .returning({ id: invoices.id });
    await tx.insert(invoiceItems).values({
      organizationId: org,
      invoiceId: inv!.id,
      description: 'Catering',
      quantity: '1',
      unitPriceCents: 10000,
      taxRate: '23',
      sortOrder: 0,
    });
    return inv!.id;
  });
}

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  h.db = db;
  await db.execute(sql.raw('SET ROLE tenant_app;'));
  invoiceA = await seedOrgInvoice(ORG_A, 'INV-2026-0001');
  invoiceB = await seedOrgInvoice(ORG_B, 'INV-2026-0009');
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

beforeEach(() => {
  h.auth = { manager: true, orgId: ORG_A, userId: 'user_1' };
  h.email = { calls: [], throwError: false };
});

describe('emailDocumentAction', () => {
  it('refuses a kitchen user with FORBIDDEN before any send', async () => {
    h.auth = { manager: false, orgId: ORG_A, userId: 'kitchen_1' };
    const res = await emailDocumentAction({
      documentType: 'invoice',
      invoiceId: invoiceA,
      recipient: 'client@example.com',
    });
    expect(res).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(h.email.calls).toHaveLength(0);
  });

  it('rejects an invalid recipient with INVALID_INPUT and never sends', async () => {
    const res = await emailDocumentAction({
      documentType: 'invoice',
      invoiceId: invoiceA,
      recipient: 'not-an-email',
    });
    expect(res).toEqual({ ok: false, code: 'INVALID_INPUT' });
    expect(h.email.calls).toHaveLength(0);
  });

  it('returns RATE_LIMITED once the documentEmail budget is spent', async () => {
    const key = rateLimitKey('documentEmail', `${ORG_A}:rl_user`);
    await db.insert(rateLimits).values({ key, windowStart: sql`now()`, count: 10 });
    h.auth = { manager: true, orgId: ORG_A, userId: 'rl_user' };
    const res = await emailDocumentAction({
      documentType: 'invoice',
      invoiceId: invoiceA,
      recipient: 'client@example.com',
    });
    expect(res).toEqual({ ok: false, code: 'RATE_LIMITED' });
    expect(h.email.calls).toHaveLength(0);
  });

  it('sends a PDF once and audits document.email (PII-free) only after acceptance', async () => {
    const res = await emailDocumentAction({
      documentType: 'invoice',
      invoiceId: invoiceA,
      recipient: 'client@example.com',
    });
    expect(res).toEqual({ ok: true, data: { id: 'msg_test_123' } });

    // Sent exactly once, with a real PDF attachment.
    expect(h.email.calls).toHaveLength(1);
    const sent = h.email.calls[0]!;
    expect(sent.to).toBe('client@example.com');
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments[0]!.filename).toBe('INV-2026-0001.pdf');
    expect(sent.attachments[0]!.content.subarray(0, 4).toString('latin1')).toBe('%PDF');

    // One audit row in ORG_A, metadata = documentType + provider id only (no PII).
    const audited = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select({ metadata: auditLog.metadata, entityId: auditLog.entityId })
        .from(auditLog)
        .where(and(eq(auditLog.organizationId, ORG_A), eq(auditLog.action, 'document.email'))),
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]!.entityId).toBe(invoiceA);
    const meta = audited[0]!.metadata as Record<string, unknown>;
    expect(meta).toEqual({ documentType: 'invoice', providerMessageId: 'msg_test_123' });
    // No recipient address or amounts leaked into the audit log.
    const json = JSON.stringify(meta);
    expect(json).not.toContain('client@example.com');
    expect(json).not.toContain('12300');
  });

  it('maps a provider failure to EMAIL_FAILED and writes NO audit row', async () => {
    h.auth = { manager: true, orgId: ORG_A, userId: 'fail_user' };
    h.email.throwError = true;
    const res = await emailDocumentAction({
      documentType: 'invoice',
      invoiceId: invoiceA,
      recipient: 'bounce@example.com',
    });
    expect(res).toEqual({ ok: false, code: 'EMAIL_FAILED' });

    const audited = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select({ id: auditLog.entityId })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.organizationId, ORG_A),
            eq(auditLog.action, 'document.email'),
            eq(auditLog.actorUserId, 'fail_user'),
          ),
        ),
    );
    expect(audited).toHaveLength(0);
  });

  it('returns NOT_FOUND for a cross-tenant invoice id and never attaches it', async () => {
    // Acting as ORG_A but referencing ORG_B's invoice.
    h.auth = { manager: true, orgId: ORG_A, userId: 'user_1' };
    const res = await emailDocumentAction({
      documentType: 'invoice',
      invoiceId: invoiceB,
      recipient: 'client@example.com',
    });
    expect(res).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(h.email.calls).toHaveLength(0);
  });
});
