import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { runInOrg } from '@/lib/db/tenant';
import type { TenantDb } from '@/lib/db/tenant';
import { aiExtractionAttempts } from '@/lib/db/schema';
import {
  createExtractionAttempt,
  markAttemptSucceeded,
  markAttemptFailed,
  countExtractionUsageSince,
  EXTRACTION_INFLIGHT_MS,
  monthStartUtc,
} from '@/lib/data/ai-extraction';
import {
  createOperationAttempt,
  markOperationSucceeded,
  countOperationUsageByFeatureSince,
} from '@/lib/data/ai-operation-attempts';
import { AI_USAGE_FEATURES } from '@/lib/ai/usage-features';
import type { AiOperationFeature } from '@/lib/ai/operation-types';
import {
  buildSidebarAiMeterView,
  buildUsageRow,
  nextMonthResetUtc,
  type PhotoExtractionUsageSummary,
} from '@/lib/data/ai-usage';
import type { EntitlementSource } from '@/lib/entitlements';

/**
 * Data-layer tests for the AI usage meter (2026-07). Cover the combined DISPLAY counts
 * (`used` = succeeded-this-month, `reserved` = used + fresh pending) for both ledgers,
 * the grouped-by-feature operation count, org isolation via RLS, the pure meter-row
 * math (incl. over-cap), the reset boundary, and the `menu_engineering_explanation`
 * exclusion. Enforcement is tested elsewhere — these helpers never gate a call.
 */

const ORG_A = 'org_usage_a';
const ORG_B = 'org_usage_b';

let client: PGlite;
let db: TenantDb;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
});

afterAll(async () => {
  await client.close();
});

/** Insert a succeeded extraction attempt, optionally backdated. */
async function seedExtraction(org: string, status: 'succeeded' | 'pending' | 'failed', createdAt?: Date) {
  const a = await runInOrg(db, org, (tx) =>
    createExtractionAttempt(tx, org, {
      actorUserId: 'u',
      provider: 'google',
      model: 'gemini-2.5-flash',
      imageCount: 1,
    }),
  );
  if (status === 'succeeded') {
    await runInOrg(db, org, (tx) =>
      markAttemptSucceeded(tx, org, a.id, {
        importJobId: null,
        inputTokens: null,
        outputTokens: null,
        costMicros: null,
        qualityFlags: [],
      }),
    );
  } else if (status === 'failed') {
    await runInOrg(db, org, (tx) =>
      markAttemptFailed(tx, org, a.id, { errorCode: 'AI_EXTRACTION_FAILED' }),
    );
  }
  if (createdAt) {
    await db
      .update(aiExtractionAttempts)
      .set({ createdAt })
      .where(eq(aiExtractionAttempts.id, a.id));
  }
  return a.id;
}

async function seedOperation(
  org: string,
  feature: AiOperationFeature,
  status: 'succeeded' | 'pending',
) {
  const a = await runInOrg(db, org, (tx) =>
    createOperationAttempt(tx, org, {
      actorUserId: 'u',
      feature,
      provider: 'google',
      model: 'gemini-2.5-flash',
    }),
  );
  if (status === 'succeeded') {
    await runInOrg(db, org, (tx) =>
      markOperationSucceeded(tx, org, a.id, {
        inputTokens: null,
        outputTokens: null,
        costMicros: null,
        qualityFlags: [],
      }),
    );
  }
  return a.id;
}

describe('countExtractionUsageSince (photo ledger, used vs reserved)', () => {
  it('used = succeeded this month; reserved adds fresh pending, excludes failed/stale/prev', async () => {
    const now = new Date();
    const monthStart = monthStartUtc(now);

    await seedExtraction(ORG_A, 'succeeded'); // counts in both
    await seedExtraction(ORG_A, 'succeeded'); // counts in both
    await seedExtraction(ORG_A, 'pending'); // reserved only (fresh)
    await seedExtraction(ORG_A, 'failed'); // neither
    // Stale pending (older than the in-flight horizon) → released, counts in neither.
    await seedExtraction(
      ORG_A,
      'pending',
      new Date(now.getTime() - EXTRACTION_INFLIGHT_MS - 60_000),
    );
    // Previous-month succeeded → outside the window, counts in neither.
    await seedExtraction(
      ORG_A,
      'succeeded',
      new Date(monthStart.getTime() - 24 * 60 * 60 * 1000),
    );

    const counts = await runInOrg(db, ORG_A, (tx) =>
      countExtractionUsageSince(tx, ORG_A, monthStart, now),
    );
    expect(counts).toEqual({ used: 2, reserved: 3 });
  });

  it('is org-isolated — another org’s attempts never leak in', async () => {
    const now = new Date();
    const monthStart = monthStartUtc(now);
    await seedExtraction(ORG_B, 'succeeded');
    const b = await runInOrg(db, ORG_B, (tx) =>
      countExtractionUsageSince(tx, ORG_B, monthStart, now),
    );
    expect(b.used).toBe(1);
    // Org A's count is unchanged by org B's row (still the 2 succeeded from above).
    const a = await runInOrg(db, ORG_A, (tx) =>
      countExtractionUsageSince(tx, ORG_A, monthStart, now),
    );
    expect(a.used).toBe(2);
  });

  it('RLS scopes the grouped read to the active org', async () => {
    const now = new Date();
    const monthStart = monthStartUtc(now);
    await db.execute(sql.raw('SET ROLE tenant_app;'));
    try {
      const a = await runInOrg(db, ORG_A, (tx) =>
        countExtractionUsageSince(tx, ORG_A, monthStart, now),
      );
      expect(a.used).toBe(2);
    } finally {
      await db.execute(sql.raw('RESET ROLE;'));
    }
  });
});

describe('countOperationUsageByFeatureSince (generic ledger, grouped)', () => {
  it('groups used/reserved per feature and excludes menu_engineering from the meter', async () => {
    const org = 'org_usage_ops';
    const now = new Date();
    const monthStart = monthStartUtc(now);

    await seedOperation(org, 'supplier_invoice_extraction', 'succeeded');
    await seedOperation(org, 'supplier_invoice_extraction', 'succeeded');
    await seedOperation(org, 'supplier_invoice_extraction', 'pending');
    await seedOperation(org, 'daily_close_summary', 'succeeded');
    // Present in the ledger but NOT a meter feature — must never surface as a row.
    await seedOperation(org, 'menu_engineering_explanation', 'succeeded');

    const map = await runInOrg(db, org, (tx) =>
      countOperationUsageByFeatureSince(tx, org, monthStart, now),
    );

    expect(map.get('supplier_invoice_extraction')).toEqual({ used: 2, reserved: 3 });
    expect(map.get('daily_close_summary')).toEqual({ used: 1, reserved: 1 });
    // menu_engineering is not in the display registry, so it is never rendered.
    expect(AI_USAGE_FEATURES).not.toContain('menu_engineering_explanation');

    // A feature with no rows is absent → callers default to zero.
    expect(map.get('kitchen_cfo_report')).toBeUndefined();
  });

  it('is org-isolated', async () => {
    const now = new Date();
    const monthStart = monthStartUtc(now);
    await seedOperation(ORG_B, 'profit_leak_explanation', 'succeeded');
    const map = await runInOrg(db, ORG_A, (tx) =>
      countOperationUsageByFeatureSince(tx, ORG_A, monthStart, now),
    );
    expect(map.get('profit_leak_explanation')).toBeUndefined();
  });
});

describe('buildUsageRow (pure meter math)', () => {
  it('computes remaining/availableNow and clamps over-cap to zero', () => {
    expect(buildUsageRow('photo_recipe_extraction', { used: 3, reserved: 4 }, 10)).toEqual({
      feature: 'photo_recipe_extraction',
      used: 3,
      reserved: 4,
      limit: 10,
      remaining: 7,
      availableNow: 6,
    });
    // Over-cap after a downgrade: show the truthful `used`, but never negative headroom.
    const over = buildUsageRow('supplier_invoice_extraction', { used: 12, reserved: 12 }, 10);
    expect(over.used).toBe(12);
    expect(over.remaining).toBe(0);
    expect(over.availableNow).toBe(0);
  });
});

describe('buildSidebarAiMeterView (pure sidebar meter projection)', () => {
  function summary(
    source: EntitlementSource,
    used: number,
    limit: number,
  ): PhotoExtractionUsageSummary {
    return {
      tier: 'business',
      source,
      resetAt: nextMonthResetUtc(new Date('2026-07-03T00:00:00Z')),
      row: buildUsageRow('photo_recipe_extraction', { used, reserved: used }, limit),
    };
  }

  it('returns null when the plan grants no photo allowance', () => {
    expect(buildSidebarAiMeterView(summary('free', 0, 0))).toBeNull();
  });

  it('picks Upgrade → /pricing for trial and free', () => {
    for (const source of ['trial', 'free'] as const) {
      expect(buildSidebarAiMeterView(summary(source, 5, 50))?.cta).toEqual({
        labelKey: 'upgrade',
        href: '/pricing',
      });
    }
  });

  it('picks Manage plan → /billing for paid', () => {
    expect(buildSidebarAiMeterView(summary('paid', 5, 100))?.cta).toEqual({
      labelKey: 'managePlan',
      href: '/billing',
    });
  });

  it('has no CTA for comped', () => {
    expect(buildSidebarAiMeterView(summary('comped', 5, 500))?.cta).toBeNull();
  });

  it('clamps percent at 100 and remaining at 0 for over-cap usage', () => {
    const view = buildSidebarAiMeterView(summary('free', 12, 10));
    expect(view?.percent).toBe(100);
    expect(view?.remaining).toBe(0);
    expect(view?.used).toBe(12);
  });

  it('computes percent from used / limit', () => {
    expect(buildSidebarAiMeterView(summary('trial', 5, 50))?.percent).toBe(10);
  });
});

describe('nextMonthResetUtc', () => {
  it('is the first instant of the next UTC month', () => {
    expect(nextMonthResetUtc(new Date('2026-07-03T13:45:10Z')).toISOString()).toBe(
      '2026-08-01T00:00:00.000Z',
    );
    // December rolls into next January.
    expect(nextMonthResetUtc(new Date('2026-12-20T00:00:00Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });
});
