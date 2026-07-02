import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import {
  emailOutbox,
  ingredients,
  organizationSettings,
  subscriptions,
} from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';

/**
 * Integration test for the weekly CFO-report ENQUEUE cron (React Email migration).
 * Real handler against PGlite under `tenant_app`, with Clerk/env/rate-limit stubbed.
 * Proves: 401 without the secret, 429 over the limit, no-op when email is
 * unconfigured, and — across four orgs processed in one run — that a row is queued
 * ONLY for an opted-in, paid, business-email org with real data; opt-in OFF, missing
 * email, and Starter each queue nothing; and a re-run is idempotent (the outbox
 * unique (org, dedup_key) blocks a duplicate). Nothing is ever sent — the worker
 * delivers separately.
 */
const ORG_PAID = 'org_paid';
const ORG_OFF = 'org_off';
const ORG_NOEMAIL = 'org_noemail';
const ORG_STARTER = 'org_starter';

const ORGS = [ORG_PAID, ORG_OFF, ORG_NOEMAIL, ORG_STARTER];

const h = vi.hoisted(() => ({
  db: null as unknown,
  emailOn: true,
  rateLimited: false,
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
        data: ORGS.map((id) => ({ id, name: id })),
        totalCount: ORGS.length,
      }),
    },
  }),
}));

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

import { GET } from '@/app/api/cron/cfo-report/route';

let client: PGlite;
let db: TenantDb;

const callWith = (header: string | null) =>
  GET(
    new Request('http://test/api/cron/cfo-report', {
      headers: header ? { authorization: header } : {},
    }),
  );

/** Seed an org's settings; optionally a paid mirror and a low-stock ingredient (data). */
async function seedOrg(
  org: string,
  opts: { enabled: boolean; email: string | null; paid?: boolean; data?: boolean },
) {
  await runInOrg(db, org, async (tx) => {
    await tx.insert(organizationSettings).values({
      organizationId: org,
      currency: 'EUR',
      measurementSystem: 'metric',
      businessEmail: opts.email,
      weeklyCfoReportEmailEnabled: opts.enabled,
    });
    if (opts.paid) {
      await tx.insert(subscriptions).values({
        organizationId: org,
        plan: 'business',
        status: 'active',
        lastEventType: 'subscription.active',
        lastEventAt: new Date(),
      });
    }
    if (opts.data) {
      // An active ingredient at/below its reorder threshold → report.hasData = true,
      // without needing seeded sales.
      await tx.insert(ingredients).values({
        organizationId: org,
        name: 'Flour',
        dimension: 'weight',
        stockQuantity: '0',
        lowStockThreshold: '100',
      });
    }
  });
}

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  h.db = db;
  await db.execute(sql.raw('SET ROLE tenant_app;'));

  await seedOrg(ORG_PAID, { enabled: true, email: 'owner@paid.test', paid: true, data: true });
  await seedOrg(ORG_OFF, { enabled: false, email: 'owner@off.test', paid: true, data: true });
  await seedOrg(ORG_NOEMAIL, { enabled: true, email: null, paid: true, data: true });
  await seedOrg(ORG_STARTER, { enabled: true, email: 'owner@starter.test', data: true });
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

beforeEach(() => {
  h.emailOn = true;
  h.rateLimited = false;
});

const rowsFor = (org: string) =>
  runInOrg(db, org, (tx) =>
    tx.select().from(emailOutbox).where(eq(emailOutbox.organizationId, org)),
  );

describe('GET /api/cron/cfo-report', () => {
  it('401 without the cron secret', async () => {
    expect((await callWith(null)).status).toBe(401);
  });

  it('429 when rate limited', async () => {
    h.rateLimited = true;
    expect((await callWith('Bearer secret')).status).toBe(429);
  });

  it('no-op when email is not configured', async () => {
    h.emailOn = false;
    const res = await callWith('Bearer secret');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped?: string };
    expect(body.skipped).toBe('email-not-configured');
  });

  it('queues exactly one row — for the opted-in paid org with data — and skips the rest', async () => {
    const res = await callWith('Bearer secret');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queued: number; weekTo: string };
    expect(body.queued).toBe(1);

    const paid = await rowsFor(ORG_PAID);
    expect(paid).toHaveLength(1);
    expect(paid[0]!.documentType).toBe('cfo_report');
    expect(paid[0]!.toEmail).toBe('owner@paid.test');
    expect(paid[0]!.dedupKey).toBe(`cfo_report:${body.weekTo}`);
    expect(paid[0]!.documentId).toBe(body.weekTo);

    // Opt-in OFF, missing email, and Starter each queue nothing.
    expect(await rowsFor(ORG_OFF)).toHaveLength(0);
    expect(await rowsFor(ORG_NOEMAIL)).toHaveLength(0);
    expect(await rowsFor(ORG_STARTER)).toHaveLength(0);
  });

  it('is idempotent: a second run for the same week queues no duplicate', async () => {
    const res = await callWith('Bearer secret');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queued: number };
    expect(body.queued).toBe(0);
    expect(await rowsFor(ORG_PAID)).toHaveLength(1);
  });
});
