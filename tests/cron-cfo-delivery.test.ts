import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import {
  auditLog,
  emailOutbox,
  ingredients,
  organizationSettings,
} from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';

/**
 * Integration test for the CFO-report delivery path of the outbox worker (React
 * Email migration). Real handler against PGlite under `tenant_app`, sender + Clerk +
 * env stubbed. Across three orgs in one run it proves: a claimed `cfo_report` row is
 * rendered from the DETERMINISTIC report and sent with `attachments: []` and an
 * idempotency key equal to the dedup key, then marked sent with `report.cfoEmail`
 * audited (safe counts only, never the recipient); a provider failure marks the row
 * for retry and writes NO audit; and an org that opted out after enqueue has its row
 * CANCELLED (not failed) with no send. No AI provider is mocked or called.
 */
const WEEK_TO = '2026-07-02';
const ORG_OK = 'org_ok';
const ORG_FAIL = 'org_fail';
const ORG_CANCEL = 'org_cancel';
const ORGS = [ORG_OK, ORG_FAIL, ORG_CANCEL];

const h = vi.hoisted(() => ({
  db: null as unknown,
  emailOn: true,
  rateLimited: false,
  send: vi.fn(async (input: { to: string }) => {
    if (input.to.includes('fail')) throw new Error('provider rejected');
    return { id: 'cfo-msg-1' };
  }),
}));

vi.mock('@/lib/cron-auth', () => ({
  isCronAuthorized: (header: string | null, secret: string) =>
    !!secret && header === `Bearer ${secret}`,
}));

vi.mock('@/lib/env', () => ({
  serverEnv: () => ({ CRON_SECRET: 'secret' }),
  isEmailConfigured: () => h.emailOn,
  emailAppUrl: () => null,
}));

vi.mock('@/lib/rate-limit', () => ({
  enforceRateLimit: vi.fn(async () => ({ allowed: !h.rateLimited })),
}));

vi.mock('@clerk/nextjs/server', () => ({
  clerkClient: async () => ({
    organizations: {
      getOrganizationList: async () => ({
        data: ORGS.map((id) => ({ id, name: id })),
        totalCount: ORGS.length,
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

const callWith = (header: string | null) =>
  GET(
    new Request('http://test/api/cron/process-email-outbox', {
      headers: header ? { authorization: header } : {},
    }),
  );

async function seedOrg(org: string, opts: { enabled: boolean; email: string }) {
  await runInOrg(db, org, async (tx) => {
    await tx.insert(organizationSettings).values({
      organizationId: org,
      currency: 'EUR',
      measurementSystem: 'metric',
      businessEmail: opts.email,
      weeklyCfoReportEmailEnabled: opts.enabled,
    });
    // Low-stock ingredient → the deterministic report has data.
    await tx.insert(ingredients).values({
      organizationId: org,
      name: 'Flour',
      dimension: 'weight',
      stockQuantity: '0',
      lowStockThreshold: '100',
    });
    await tx.insert(emailOutbox).values({
      organizationId: org,
      documentType: 'cfo_report',
      documentId: WEEK_TO,
      toEmail: opts.email,
      subject: 'Your weekly CFO report',
      dedupKey: `cfo_report:${WEEK_TO}`,
    });
  });
}

const rowFor = (org: string) =>
  runInOrg(db, org, (tx) =>
    tx.select().from(emailOutbox).where(eq(emailOutbox.organizationId, org)),
  );

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  h.db = db;
  await db.execute(sql.raw('SET ROLE tenant_app;'));

  await seedOrg(ORG_OK, { enabled: true, email: 'owner@ok.test' });
  await seedOrg(ORG_FAIL, { enabled: true, email: 'owner@fail.test' });
  await seedOrg(ORG_CANCEL, { enabled: false, email: 'owner@cancel.test' });
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

describe('GET /api/cron/process-email-outbox — CFO report delivery', () => {
  it('sends the opted-in row, cancels the opted-out one, retries the failed one', async () => {
    const res = await callWith('Bearer secret');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      processed: number;
      sent: number;
      failed: number;
      cancelled: number;
    };
    expect(body.processed).toBe(3);
    expect(body.sent).toBe(1);
    expect(body.cancelled).toBe(1);
    expect(body.failed).toBe(1);

    // The opted-in org: sent with NO attachment and idempotencyKey == dedupKey.
    const okCall = h.send.mock.calls
      .map((c) => c[0] as { to: string; idempotencyKey: string; attachments: unknown[] })
      .find((c) => c.to === 'owner@ok.test');
    expect(okCall).toBeDefined();
    expect(okCall!.attachments).toEqual([]);
    expect(okCall!.idempotencyKey).toBe(`cfo_report:${WEEK_TO}`);

    const okRow = await rowFor(ORG_OK);
    expect(okRow[0]!.status).toBe('sent');
    expect(okRow[0]!.providerMessageId).toBe('cfo-msg-1');

    // Audit: report.cfoEmail with safe counts only, never the recipient address.
    const audited = await runInOrg(db, ORG_OK, (tx) =>
      tx
        .select({ metadata: auditLog.metadata, entityId: auditLog.entityId })
        .from(auditLog)
        .where(and(eq(auditLog.organizationId, ORG_OK), eq(auditLog.action, 'report.cfoEmail'))),
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]!.entityId).toBe(WEEK_TO);
    const meta = audited[0]!.metadata as Record<string, unknown>;
    expect(meta.weekTo).toBe(WEEK_TO);
    expect(meta.providerMessageId).toBe('cfo-msg-1');
    expect(meta.lowStockCount).toBe(1);
    expect(JSON.stringify(meta)).not.toContain('owner@ok.test');

    // The opted-out org: cancelled, never sent, and no send-audit.
    const cancelRow = await rowFor(ORG_CANCEL);
    expect(cancelRow[0]!.status).toBe('cancelled');
    expect(cancelRow[0]!.providerMessageId).toBeNull();
    expect(h.send.mock.calls.some((c) => (c[0] as { to: string }).to === 'owner@cancel.test')).toBe(
      false,
    );

    // The failing org: NOT sent, queued for retry (attempts incremented), no audit.
    const failRow = await rowFor(ORG_FAIL);
    expect(failRow[0]!.providerMessageId).toBeNull();
    expect(failRow[0]!.status).toBe('pending');
    expect(failRow[0]!.attempts).toBe(1);
    const failAudit = await runInOrg(db, ORG_FAIL, (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(and(eq(auditLog.organizationId, ORG_FAIL), eq(auditLog.action, 'report.cfoEmail'))),
    );
    expect(failAudit[0]!.n).toBe(0);
  });

  it('re-run never resends the already-sent CFO row', async () => {
    // Reset the failing org so only the sent + cancelled rows remain terminal.
    await runInOrg(db, ORG_FAIL, (tx) =>
      tx
        .update(emailOutbox)
        .set({ status: 'cancelled' })
        .where(eq(emailOutbox.organizationId, ORG_FAIL)),
    );
    const res = await callWith('Bearer secret');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number };
    expect(body.processed).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
  });
});
