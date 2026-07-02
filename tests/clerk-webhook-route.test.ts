import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import {
  auditLog,
  organizationSettings,
  subscriptions,
  transactionCategories,
} from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';

/**
 * Sprint 4c — Clerk webhook route. Runs the real handler against PGlite under the
 * non-privileged `tenant_app` role (RLS enforced), with `verifyWebhook` and
 * `@/lib/db` stubbed. Proves: a forged signature → 400 with NO DB write; a verified
 * subscription event upserts the mirror + a `subscription.*` audit row in the
 * active org ONLY; past_due → lapse; org.deleted lapses without deleting data;
 * membership → audit only.
 */
const ORG_A = 'org_a';
const ORG_B = 'org_b';

const h = vi.hoisted(() => ({
  db: null as unknown,
  event: null as unknown,
  throwVerify: false,
}));

/** Captures the reverse-trial metadata write (organization.created, Slice 3). */
const clerkMock = vi.hoisted(() => ({
  updateOrganizationMetadata: vi.fn(
    async (_orgId: string, _params: { publicMetadata: Record<string, unknown> }) => ({}),
  ),
}));

vi.mock('@clerk/nextjs/webhooks', () => ({
  verifyWebhook: vi.fn(async () => {
    if (h.throwVerify) throw new Error('signature verification failed');
    return h.event;
  }),
}));

vi.mock('@clerk/nextjs/server', () => ({
  clerkClient: vi.fn(async () => ({
    organizations: {
      updateOrganizationMetadata: clerkMock.updateOrganizationMetadata,
    },
  })),
}));

vi.mock('@/lib/db', () => ({
  withOrg: async (org: string, fn: (tx: unknown) => unknown) => {
    const { runInOrg: rio } = await import('@/lib/db/tenant');
    return rio(h.db as TenantDb, org, fn as never);
  },
}));

// Import the route AFTER the mocks are registered.
import { POST } from '@/app/api/webhooks/clerk/route';

let client: PGlite;
let db: TenantDb;

function post(event: unknown, { forged = false } = {}) {
  h.event = event;
  h.throwVerify = forged;
  return POST(
    new NextRequest('http://test/api/webhooks/clerk', {
      method: 'POST',
      headers: { 'svix-id': 'msg_test_1' },
    }),
  );
}

function subscriptionEvent(
  type: string,
  orgId: string | undefined,
  status: string,
  items: Array<{ status: string; slug: string | null; periodEnd: number | null }>,
  updatedAt = Date.parse('2026-06-10T00:00:00Z'),
) {
  return {
    type,
    object: 'event',
    data: {
      id: 'sub_123',
      status,
      updated_at: updatedAt,
      payer: orgId ? { organization_id: orgId } : {},
      items: items.map((i) => ({
        status: i.status,
        period_end: i.periodEnd,
        plan: i.slug ? { slug: i.slug } : null,
      })),
    },
  };
}

async function mirror(org: string) {
  return runInOrg(db, org, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.organizationId, org)),
  );
}

async function audits(org: string, action: string) {
  return runInOrg(db, org, (tx) =>
    tx
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.organizationId, org), eq(auditLog.action, action))),
  );
}

async function settings(org: string) {
  return runInOrg(db, org, (tx) =>
    tx
      .select()
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, org)),
  );
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

describe('POST /api/webhooks/clerk', () => {
  it('rejects a forged/unverifiable webhook with 400 and writes nothing', async () => {
    const res = await post(
      subscriptionEvent('subscription.active', ORG_A, 'active', [
        { status: 'active', slug: 'pro', periodEnd: null },
      ]),
      { forged: true },
    );
    expect(res.status).toBe(400);

    const rows = await mirror(ORG_A);
    expect(rows).toHaveLength(0);
  });

  it('upserts the mirror + audits a verified subscription.active in the active org only', async () => {
    const res = await post(
      subscriptionEvent('subscription.active', ORG_A, 'active', [
        { status: 'active', slug: 'business', periodEnd: Date.parse('2026-07-10T00:00:00Z') },
      ]),
    );
    expect(res.status).toBe(200);

    const rows = await mirror(ORG_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.plan).toBe('business');
    expect(rows[0]?.status).toBe('active');
    expect(rows[0]?.clerkSubscriptionId).toBe('sub_123');
    expect(rows[0]?.currentPeriodEnd).toEqual(new Date('2026-07-10T00:00:00Z'));

    expect(await audits(ORG_A, 'subscription.update')).toHaveLength(1);

    // Nothing leaked into ORG_B.
    expect(await mirror(ORG_B)).toHaveLength(0);
    expect(await audits(ORG_B, 'subscription.update')).toHaveLength(0);
  });

  it('treats subscription.pastDue as a lapse', async () => {
    const res = await post(
      subscriptionEvent('subscription.pastDue', ORG_A, 'past_due', [
        { status: 'past_due', slug: 'business', periodEnd: null },
      ], Date.parse('2026-06-11T00:00:00Z')),
    );
    expect(res.status).toBe(200);

    const rows = await mirror(ORG_A);
    expect(rows[0]?.status).toBe('past_due');
    expect(await audits(ORG_A, 'subscription.lapse')).toHaveLength(1);
  });

  it('ignores a user-payer subscription (no org) and acknowledges', async () => {
    const res = await post(
      subscriptionEvent('subscription.active', undefined, 'active', [
        { status: 'active', slug: 'pro', periodEnd: null },
      ]),
    );
    expect(res.status).toBe(200);
    // ORG_A mirror unchanged from the previous (past_due) test.
    const rows = await mirror(ORG_A);
    expect(rows[0]?.status).toBe('past_due');
  });

  it('lapses the mirror on organization.deleted without deleting tenant data', async () => {
    const res = await post({
      type: 'organization.deleted',
      object: 'event',
      data: { id: ORG_A, object: 'organization', deleted: true },
    });
    expect(res.status).toBe(200);

    const rows = await mirror(ORG_A);
    expect(rows[0]?.status).toBe('canceled');
    expect(rows[0]?.plan).toBe('starter');
    expect(await audits(ORG_A, 'subscription.lapse')).toHaveLength(2);
  });

  it('seeds tenant defaults + audits on organization.created (Sprint 4d)', async () => {
    const NEW_ORG = 'org_fresh';
    const res = await post({
      type: 'organization.created',
      object: 'event',
      data: {
        id: NEW_ORG,
        object: 'organization',
        created_at: Date.parse('2026-06-20T00:00:00Z'),
      },
    });
    expect(res.status).toBe(200);

    // Predefined transaction categories were seeded.
    const cats = await runInOrg(db, NEW_ORG, (tx) =>
      tx
        .select()
        .from(transactionCategories)
        .where(eq(transactionCategories.organizationId, NEW_ORG)),
    );
    expect(cats.length).toBeGreaterThan(0);

    // A settings row exists, primed but NOT onboarded.
    const settings = await runInOrg(db, NEW_ORG, (tx) =>
      tx
        .select()
        .from(organizationSettings)
        .where(eq(organizationSettings.organizationId, NEW_ORG)),
    );
    expect(settings).toHaveLength(1);
    expect(settings[0]?.onboardedAt).toBeNull();

    expect(await audits(NEW_ORG, 'organization.create')).toHaveLength(1);
  });

  it('stamps a 14-day reverse trial from the org created_at (idempotent on retry)', async () => {
    const TRIAL_ORG = 'org_trial';
    const createdAt = Date.parse('2026-06-20T00:00:00Z');
    const expectedEnd = new Date(createdAt + 14 * 24 * 60 * 60 * 1000).toISOString();
    const event = {
      type: 'organization.created',
      object: 'event',
      data: { id: TRIAL_ORG, object: 'organization', created_at: createdAt },
    };

    clerkMock.updateOrganizationMetadata.mockClear();
    expect((await post(event)).status).toBe(200);
    expect(clerkMock.updateOrganizationMetadata).toHaveBeenCalledWith(TRIAL_ORG, {
      publicMetadata: { trial_ends_at: expectedEnd },
    });

    // A Svix retry of the SAME delivery recomputes the identical deadline (derived
    // from the immutable created_at, not processing time).
    expect((await post(event)).status).toBe(200);
    expect(clerkMock.updateOrganizationMetadata).toHaveBeenLastCalledWith(TRIAL_ORG, {
      publicMetadata: { trial_ends_at: expectedEnd },
    });
  });

  it('returns 500 (Svix will retry) when the trial-metadata write fails', async () => {
    const FAIL_ORG = 'org_trial_fail';
    clerkMock.updateOrganizationMetadata.mockRejectedValueOnce(new Error('clerk 5xx'));
    const res = await post({
      type: 'organization.created',
      object: 'event',
      data: {
        id: FAIL_ORG,
        object: 'organization',
        created_at: Date.parse('2026-06-20T00:00:00Z'),
      },
    });
    expect(res.status).toBe(500);
  });

  it('marks the org onboarded on a paid subscription (escapes the onboarding loop)', async () => {
    const ORG_PAID = 'org_paid';
    // A manager who subscribed to Pro during onboarding: the checkout reload reset
    // the stepper, so they never clicked "Finish". This event must mark them
    // onboarded so /dashboard stops bouncing them back to /onboarding.
    expect(await settings(ORG_PAID)).toHaveLength(0);

    const res = await post(
      subscriptionEvent('subscription.created', ORG_PAID, 'active', [
        { status: 'active', slug: 'pro', periodEnd: null },
      ]),
    );
    expect(res.status).toBe(200);

    const rows = await settings(ORG_PAID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.onboardedAt).toBeInstanceOf(Date);
  });

  it('does NOT mark onboarded for a starter (free) subscription', async () => {
    const ORG_FREE = 'org_free';
    const res = await post(
      subscriptionEvent('subscription.active', ORG_FREE, 'active', [
        { status: 'active', slug: 'free_org', periodEnd: null },
      ]),
    );
    expect(res.status).toBe(200);

    // No paid plan → markOnboarded never runs, so no settings row is created and
    // the org still goes through the guided onboarding flow.
    expect(await settings(ORG_FREE)).toHaveLength(0);
  });

  it('audits a membership event without touching the mirror', async () => {
    const before = (await mirror(ORG_B)).length;
    const res = await post({
      type: 'organizationMembership.created',
      object: 'event',
      data: {
        organization: { id: ORG_B },
        public_user_data: { user_id: 'user_x' },
        role: 'org:member',
      },
    });
    expect(res.status).toBe(200);

    expect(await audits(ORG_B, 'organization.membership')).toHaveLength(1);
    expect((await mirror(ORG_B)).length).toBe(before);
  });
});
