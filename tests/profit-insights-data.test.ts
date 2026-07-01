import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { runInOrg } from '@/lib/db/tenant';
import type { TenantDb } from '@/lib/db/tenant';
import { profitInsights } from '@/lib/db/schema';
import {
  getProfitInsight,
  upsertExplanation,
  setDismissed,
  listInsightStates,
  type InsightDescriptor,
} from '@/lib/data/profit-insights';
import type { ProfitLeakExplanationData } from '@/lib/ai/operation-types';

/**
 * Data-layer + RLS tests for the profit-insight sidecar (Sprint 4, AI margin roadmap):
 * explanation caching, dismiss/restore, batch state read, and org isolation (SELECT
 * scoping + WITH CHECK on cross-org INSERT/UPDATE). No provider is involved.
 */

const ORG_A = 'org_a';
const ORG_B = 'org_b';

function descriptor(fingerprint: string): InsightDescriptor {
  return {
    fingerprint,
    findingType: 'RECIPE_BELOW_TARGET_MARGIN',
    entityType: 'recipe',
    entityId: `rec-${fingerprint}`,
  };
}

const EXPLANATION: ProfitLeakExplanationData = {
  headline: 'Below target margin',
  explanation: 'Review the selling price.',
  actionLabel: 'Review selling price',
  riskLevel: 'medium',
};

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

describe('explanation cache', () => {
  it('upserts an explanation and reads it back', async () => {
    const d = descriptor('fp-explain');
    const row = await runInOrg(db, ORG_A, (tx) =>
      upsertExplanation(tx, ORG_A, { descriptor: d, explanation: EXPLANATION, model: 'gemini-2.5-flash' }),
    );
    expect(row.explanation).toEqual(EXPLANATION);
    expect(row.explanationModel).toBe('gemini-2.5-flash');
    expect(row.dismissedAt).toBeNull();

    const fetched = await runInOrg(db, ORG_A, (tx) => getProfitInsight(tx, ORG_A, 'fp-explain'));
    expect(fetched?.explanation).toEqual(EXPLANATION);
  });

  it('re-upsert overwrites the explanation on the same fingerprint (one row)', async () => {
    const d = descriptor('fp-reexplain');
    await runInOrg(db, ORG_A, (tx) =>
      upsertExplanation(tx, ORG_A, { descriptor: d, explanation: EXPLANATION, model: 'gemini-2.5-flash' }),
    );
    const updated: ProfitLeakExplanationData = { ...EXPLANATION, riskLevel: 'high' };
    await runInOrg(db, ORG_A, (tx) =>
      upsertExplanation(tx, ORG_A, { descriptor: d, explanation: updated, model: 'gemini-2.5-flash' }),
    );
    const rows = await db
      .select()
      .from(profitInsights)
      .where(and(eq(profitInsights.organizationId, ORG_A), eq(profitInsights.fingerprint, 'fp-reexplain')));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.explanation?.riskLevel).toBe('high');
  });

  it('returns null for a never-touched finding', async () => {
    const fetched = await runInOrg(db, ORG_A, (tx) => getProfitInsight(tx, ORG_A, 'fp-missing'));
    expect(fetched).toBeNull();
  });
});

describe('dismiss / restore', () => {
  it('dismisses a never-explained finding then restores it', async () => {
    const d = descriptor('fp-dismiss');
    const dismissed = await runInOrg(db, ORG_A, (tx) => setDismissed(tx, ORG_A, d, true));
    expect(dismissed.dismissedAt).not.toBeNull();
    expect(dismissed.explanation).toBeNull();

    const restored = await runInOrg(db, ORG_A, (tx) => setDismissed(tx, ORG_A, d, false));
    expect(restored.dismissedAt).toBeNull();
  });

  it('dismissing preserves a cached explanation', async () => {
    const d = descriptor('fp-both');
    await runInOrg(db, ORG_A, (tx) =>
      upsertExplanation(tx, ORG_A, { descriptor: d, explanation: EXPLANATION, model: 'gemini-2.5-flash' }),
    );
    const dismissed = await runInOrg(db, ORG_A, (tx) => setDismissed(tx, ORG_A, d, true));
    expect(dismissed.dismissedAt).not.toBeNull();
    expect(dismissed.explanation).toEqual(EXPLANATION);
  });
});

describe('listInsightStates', () => {
  it('maps only requested fingerprints; empty input skips the query', async () => {
    const d = descriptor('fp-list');
    await runInOrg(db, ORG_A, (tx) =>
      upsertExplanation(tx, ORG_A, { descriptor: d, explanation: EXPLANATION, model: 'gemini-2.5-flash' }),
    );
    const states = await runInOrg(db, ORG_A, (tx) =>
      listInsightStates(tx, ORG_A, ['fp-list', 'fp-never']),
    );
    expect(states.get('fp-list')?.explanation).toEqual(EXPLANATION);
    expect(states.has('fp-never')).toBe(false);

    const empty = await runInOrg(db, ORG_A, (tx) => listInsightStates(tx, ORG_A, []));
    expect(empty.size).toBe(0);
  });
});

describe('org isolation + RLS', () => {
  it('RLS scopes an unfiltered SELECT to the active org', async () => {
    await runInOrg(db, ORG_B, (tx) => setDismissed(tx, ORG_B, descriptor('fp-b'), true));
    await db.execute(sql.raw('SET ROLE tenant_app;'));
    try {
      const rows = await runInOrg(db, ORG_A, (tx) =>
        tx.select({ org: profitInsights.organizationId }).from(profitInsights),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.org === ORG_A)).toBe(true);
    } finally {
      await db.execute(sql.raw('RESET ROLE;'));
    }
  });

  it('rejects an INSERT carrying another org id (WITH CHECK)', async () => {
    await db.execute(sql.raw('SET ROLE tenant_app;'));
    try {
      await expect(
        runInOrg(db, ORG_A, (tx) =>
          tx.insert(profitInsights).values({
            organizationId: ORG_B,
            fingerprint: 'smuggled',
            findingType: 'RECIPE_BELOW_TARGET_MARGIN',
            entityType: 'recipe',
            entityId: 'rec-x',
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await db.execute(sql.raw('RESET ROLE;'));
    }
  });

  it('rejects re-tagging a row to another org via UPDATE (WITH CHECK)', async () => {
    const id = await runInOrg(db, ORG_A, (tx) =>
      tx
        .insert(profitInsights)
        .values({
          organizationId: ORG_A,
          fingerprint: 'fp-retag',
          findingType: 'RECIPE_BELOW_TARGET_MARGIN',
          entityType: 'recipe',
          entityId: 'rec-y',
        })
        .returning({ id: profitInsights.id }),
    ).then((r) => r[0]?.id);

    await db.execute(sql.raw('SET ROLE tenant_app;'));
    try {
      await expect(
        runInOrg(db, ORG_A, (tx) =>
          tx.update(profitInsights).set({ organizationId: ORG_B }).where(eq(profitInsights.id, id!)),
        ),
      ).rejects.toThrow();
    } finally {
      await db.execute(sql.raw('RESET ROLE;'));
    }
  });
});
