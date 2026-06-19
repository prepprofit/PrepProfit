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

vi.mock('@clerk/nextjs/webhooks', () => ({
  verifyWebhook: vi.fn(async () => {
    if (h.throwVerify) throw new Error('signature verification failed');
    return h.event;
  }),
}));

vi.mock('@/lib/db', () => ({
  withOrg: async (org: string, fn: (tx: unknown) => unknown) => {
    const { runInOrg: rio } = await import('@/lib/db/tenant');
    return rio(h.db as TenantDb, org, fn as never);
  },
}));

// The org lockdown (Sprint 4e) hits the Clerk Backend API — stub it here and
// assert the route wires it on organization.created. Its own behavior is covered
// by tests/org-lockdown.test.ts.
const ensureOrgLockdownMock = vi.fn(async (_orgId: string) => {});
vi.mock('@/lib/org/lockdown', () => ({
  ensureOrgLockdown: (orgId: string) => ensureOrgLockdownMock(orgId),
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
      data: { id: NEW_ORG, object: 'organization' },
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

    // The org self-delete lockdown was triggered for the new org (Sprint 4e).
    expect(ensureOrgLockdownMock).toHaveBeenCalledWith(NEW_ORG);
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
