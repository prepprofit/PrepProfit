import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { organizationSettings, subscriptions } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';

/**
 * Integration test for the reverse-trial ending reminder cron (pricing 4-tier plan,
 * Slice 6). Real handler against PGlite under `tenant_app`, with Clerk/env/rate-limit
 * and the email notification stubbed. Proves: 401 without the secret, 429 over the
 * limit, no-op when email is unconfigured, and — across orgs processed in one run —
 * that a reminder is sent ONLY for a starter org whose trial is exactly
 * TRIAL_REMINDER_DAYS_BEFORE (3) days out; a subscribed org, an out-of-window org,
 * and an org with no trial metadata each send nothing; and an org with no business
 * email falls back to its Clerk admin address.
 */
const ORG_DUE = 'org_due';
const ORG_FAR = 'org_far';
const ORG_SUBSCRIBED = 'org_subscribed';
const ORG_NOEMAIL = 'org_noemail';
const ORG_NOTRIAL = 'org_notrial';

const dayMs = 24 * 60 * 60 * 1000;
const now = new Date();
const utcMid = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
/** Noon UTC on the calendar day `n` days from today → a stable N-days-out deadline. */
const inDays = (n: number) => new Date(utcMid + n * dayMs + 12 * 3600 * 1000).toISOString();

const TRIAL_META: Record<string, string | undefined> = {
  [ORG_DUE]: inDays(3),
  [ORG_FAR]: inDays(5),
  [ORG_SUBSCRIBED]: inDays(3),
  [ORG_NOEMAIL]: inDays(3),
  [ORG_NOTRIAL]: undefined,
};
const ORGS = Object.keys(TRIAL_META);

const h = vi.hoisted(() => ({
  db: null as unknown,
  emailOn: true,
  rateLimited: false,
  sent: [] as Array<{ to: string; orgName: string; daysLeft: number; idempotencyKey: string }>,
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

vi.mock('@/lib/email/resend', () => ({
  getEmailSender: () => ({ send: vi.fn() }),
}));

vi.mock('@/lib/email/notifications', () => ({
  sendTrialEndingEmail: vi.fn(async (_sender: unknown, params: (typeof h.sent)[number]) => {
    h.sent.push(params);
  }),
}));

vi.mock('@clerk/nextjs/server', () => ({
  clerkClient: async () => ({
    organizations: {
      getOrganizationList: async () => ({
        data: ORGS.map((id) => ({ id, name: id, publicMetadata: { trial_ends_at: TRIAL_META[id] } })),
        totalCount: ORGS.length,
      }),
      getOrganizationMembershipList: async () => ({
        data: [{ role: 'org:admin', publicUserData: { identifier: 'admin@clerk.test' } }],
      }),
    },
    users: { getUser: async () => ({ primaryEmailAddress: { emailAddress: 'admin@clerk.test' } }) },
  }),
}));

vi.mock('@/lib/db', () => ({
  getDb: () => h.db,
  withOrg: async (org: string, fn: (tx: unknown) => unknown) => {
    const { runInOrg: rio } = await import('@/lib/db/tenant');
    return rio(h.db as TenantDb, org, fn as never);
  },
}));

import { GET } from '@/app/api/cron/trial-reminder/route';

let client: PGlite;
let db: TenantDb;

const callWith = (header: string | null) =>
  GET(
    new Request('http://test/api/cron/trial-reminder', {
      headers: header ? { authorization: header } : {},
    }),
  );

async function seedOrg(org: string, opts: { email: string | null; paid?: boolean }) {
  await runInOrg(db, org, async (tx) => {
    await tx.insert(organizationSettings).values({
      organizationId: org,
      currency: 'EUR',
      measurementSystem: 'metric',
      businessEmail: opts.email,
    });
    if (opts.paid) {
      await tx.insert(subscriptions).values({
        organizationId: org,
        plan: 'pro',
        status: 'active',
        lastEventType: 'subscription.active',
        lastEventAt: new Date(),
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

  await seedOrg(ORG_DUE, { email: 'due@test' });
  await seedOrg(ORG_FAR, { email: 'far@test' });
  await seedOrg(ORG_SUBSCRIBED, { email: 'sub@test', paid: true });
  await seedOrg(ORG_NOEMAIL, { email: null });
  await seedOrg(ORG_NOTRIAL, { email: 'none@test' });
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

beforeEach(() => {
  h.emailOn = true;
  h.rateLimited = false;
  h.sent = [];
});

describe('GET /api/cron/trial-reminder', () => {
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

  it('reminds only the in-window starter orgs; subscribed / out-of-window / no-trial send nothing', async () => {
    const res = await callWith('Bearer secret');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reminded: number };
    expect(body.reminded).toBe(2);

    const byOrg = new Map(h.sent.map((s) => [s.orgName, s]));
    // ORG_DUE: business email recipient, 3 days left, org-scoped idempotency key.
    expect(byOrg.get(ORG_DUE)?.to).toBe('due@test');
    expect(byOrg.get(ORG_DUE)?.daysLeft).toBe(3);
    expect(byOrg.get(ORG_DUE)?.idempotencyKey).toBe(
      `trial_reminder:${ORG_DUE}:${TRIAL_META[ORG_DUE]}`,
    );
    // ORG_NOEMAIL: no business email → falls back to the Clerk admin address.
    expect(byOrg.get(ORG_NOEMAIL)?.to).toBe('admin@clerk.test');
    // The rest are silent.
    expect(byOrg.has(ORG_FAR)).toBe(false);
    expect(byOrg.has(ORG_SUBSCRIBED)).toBe(false);
    expect(byOrg.has(ORG_NOTRIAL)).toBe(false);
  });
});
