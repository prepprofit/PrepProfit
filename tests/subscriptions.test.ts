import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { subscriptions } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  planSlugToTier,
  resolveCurrentPeriodEnd,
  resolvePlanTier,
  upsertSubscriptionMirror,
  type SubscriptionItemInput,
} from '@/lib/data/subscriptions';

/**
 * Sprint 4c — subscription mirror. Pure resolvers (no DB) prove the slug→tier and
 * "highest current item" logic; the PGlite block proves the upsert is idempotent,
 * ORDER-SAFE (an older event never rolls back a newer state), and org-isolated.
 */

describe('planSlugToTier', () => {
  it('maps known paid slugs and collapses everything else to starter', () => {
    expect(planSlugToTier('business')).toBe('business');
    expect(planSlugToTier('pro')).toBe('pro');
    expect(planSlugToTier('free_org')).toBe('starter');
    expect(planSlugToTier('something_unknown')).toBe('starter');
    expect(planSlugToTier(null)).toBe('starter');
    expect(planSlugToTier(undefined)).toBe('starter');
  });
});

describe('resolvePlanTier', () => {
  const item = (
    status: string,
    planSlug: string | null,
    periodEnd: number | null = null,
  ): SubscriptionItemInput => ({ status, planSlug, periodEnd });

  it('returns starter for an empty / fully-inactive subscription', () => {
    expect(resolvePlanTier([])).toBe('starter');
    expect(resolvePlanTier([item('ended', 'business'), item('canceled', 'pro')])).toBe(
      'starter',
    );
  });

  it('picks the highest CURRENT (active/past_due) item', () => {
    expect(resolvePlanTier([item('active', 'pro')])).toBe('pro');
    expect(resolvePlanTier([item('past_due', 'business')])).toBe('business');
    expect(
      resolvePlanTier([item('active', 'pro'), item('active', 'business')]),
    ).toBe('business');
  });

  it('ignores upcoming (not-yet-active) items', () => {
    expect(
      resolvePlanTier([item('active', 'pro'), item('upcoming', 'business')]),
    ).toBe('pro');
  });
});

describe('resolveCurrentPeriodEnd', () => {
  it('returns the latest period end among current items, else null', () => {
    expect(resolveCurrentPeriodEnd([])).toBeNull();
    expect(
      resolveCurrentPeriodEnd([{ status: 'ended', planSlug: 'pro', periodEnd: 1000 }]),
    ).toBeNull();
    const end = resolveCurrentPeriodEnd([
      { status: 'active', planSlug: 'pro', periodEnd: 1000 },
      { status: 'past_due', planSlug: 'business', periodEnd: 2000 },
    ]);
    expect(end).toEqual(new Date(2000));
  });
});

describe('upsertSubscriptionMirror (PGlite, RLS-scoped)', () => {
  const ORG_A = 'org_a';
  const ORG_B = 'org_b';
  let client: PGlite;
  let db: TenantDb;

  beforeAll(async () => {
    const test = await createTestDb();
    client = test.client;
    db = test.db as unknown as TenantDb;
    await db.execute(sql.raw('SET ROLE tenant_app;'));
  });

  afterAll(async () => {
    await db.execute(sql.raw('RESET ROLE;'));
    await client.close();
  });

  async function read(org: string) {
    return runInOrg(db, org, (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.organizationId, org)),
    );
  }

  it('upserts then advances on a newer event, but ignores an older one', async () => {
    const t1 = new Date('2026-06-01T00:00:00Z');
    const t0 = new Date('2026-05-01T00:00:00Z');
    const t2 = new Date('2026-07-01T00:00:00Z');

    // Initial state: Pro, active.
    await runInOrg(db, ORG_A, (tx) =>
      upsertSubscriptionMirror(tx, ORG_A, {
        plan: 'pro',
        status: 'active',
        clerkSubscriptionId: 'sub_1',
        currentPeriodEnd: t2,
        eventType: 'subscription.active',
        eventAt: t1,
      }),
    );
    let rows = await read(ORG_A);
    expect(rows[0]?.plan).toBe('pro');
    expect(rows[0]?.status).toBe('active');

    // OLDER event tries to downgrade — the guard must reject it.
    await runInOrg(db, ORG_A, (tx) =>
      upsertSubscriptionMirror(tx, ORG_A, {
        plan: 'starter',
        status: 'canceled',
        clerkSubscriptionId: 'sub_1',
        currentPeriodEnd: null,
        eventType: 'subscription.updated',
        eventAt: t0,
      }),
    );
    rows = await read(ORG_A);
    expect(rows[0]?.plan).toBe('pro');
    expect(rows[0]?.status).toBe('active');

    // NEWER event upgrades — applied.
    await runInOrg(db, ORG_A, (tx) =>
      upsertSubscriptionMirror(tx, ORG_A, {
        plan: 'business',
        status: 'active',
        clerkSubscriptionId: 'sub_1',
        currentPeriodEnd: t2,
        eventType: 'subscription.updated',
        eventAt: t2,
      }),
    );
    rows = await read(ORG_A);
    expect(rows[0]?.plan).toBe('business');
  });

  it('isolates the mirror per org (RLS)', async () => {
    await runInOrg(db, ORG_B, (tx) =>
      upsertSubscriptionMirror(tx, ORG_B, {
        plan: 'pro',
        status: 'active',
        clerkSubscriptionId: 'sub_b',
        currentPeriodEnd: null,
        eventType: 'subscription.created',
        eventAt: new Date('2026-06-01T00:00:00Z'),
      }),
    );

    // ORG_B sees only its own row; never ORG_A's.
    const fromB = await runInOrg(db, ORG_B, (tx) => tx.select().from(subscriptions));
    expect(fromB).toHaveLength(1);
    expect(fromB[0]?.organizationId).toBe(ORG_B);
  });
});
