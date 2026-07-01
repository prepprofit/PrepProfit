import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { runInOrg } from '@/lib/db/tenant';
import type { TenantDb } from '@/lib/db/tenant';
import { aiOperationAttempts, profitInsights } from '@/lib/db/schema';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import { loadProfitLeaks } from '@/lib/data/profit-leaks';
import type { ExplainProfitLeakResult } from '@/lib/ai/profit-leak-explanation';

/**
 * Action-level tests for the Profit Insight Inbox (Sprint 4, AI margin roadmap). Proves
 * the §9 acceptance criteria at the action boundary: no explanation without a finding
 * (provider never called for an unknown fingerprint), cache short-circuits the provider,
 * the monthly cap returns USAGE_LIMIT_REACHED, a failed provider call leaves the finding
 * visible + records a `failed` attempt, and every action is manager-only. A FAKE
 * explainer is injected (no network / key).
 */

const ORG = 'org_insights';

const h = vi.hoisted(() => ({
  db: null as unknown as TenantDb,
  org: 'org_insights',
  manager: true,
  monthlyLimit: 10,
  explainCalls: 0,
  behavior: 'ok' as 'ok' | 'fail' | 'busy',
}));

vi.mock('@/lib/auth', () => ({
  getOrgId: vi.fn(async () => h.org),
  isManager: vi.fn(async () => h.manager),
  getUserId: vi.fn(async () => 'user_1'),
  getUserRole: vi.fn(async () => (h.manager ? 'manager' : 'kitchen')),
}));

vi.mock('@/lib/db', async () => {
  const { runInOrg: realRunInOrg } = await import('@/lib/db/tenant');
  return {
    getDb: () => h.db,
    withOrg: (org: string, fn: (tx: never) => unknown) =>
      realRunInOrg(h.db, org, fn as never),
  };
});

vi.mock('@/lib/rate-limit', () => ({
  enforceRateLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('@/lib/entitlements', () => ({
  profitLeakExplanationMonthlyLimit: vi.fn(async () => ({
    limit: h.monthlyLimit,
    tier: 'starter',
  })),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/ai/profit-leak-explanation', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/ai/profit-leak-explanation')
  >('@/lib/ai/profit-leak-explanation');
  return {
    ...actual,
    getProfitLeakExplainer: () => ({
      async explain(): Promise<ExplainProfitLeakResult> {
        h.explainCalls += 1;
        if (h.behavior === 'fail') {
          throw new actual.ProfitLeakExplanationError('bad output');
        }
        if (h.behavior === 'busy') {
          throw new actual.ProfitLeakExplanationError('overloaded', { retryable: true });
        }
        return {
          explanation: {
            headline: 'Below target margin',
            explanation: 'Review the selling price.',
            actionLabel: 'Review selling price',
            riskLevel: 'medium',
          },
          usage: { inputTokens: 100, outputTokens: 50 },
          model: 'gemini-2.5-flash',
          provider: 'google',
          attempts: 1,
        };
      },
    }),
  };
});

import {
  explainProfitLeakAction,
  dismissInsightAction,
  restoreInsightAction,
} from '@/app/(app)/insights/actions';

let client: PGlite;

/** Seed a below-target recipe and return the finding fingerprint. */
async function seedFinding(): Promise<string> {
  const ing = await runInOrg(h.db, ORG, (tx) =>
    createIngredient(tx, ORG, { name: 'Butter', dimension: 'count', priceCents: 800 }),
  );
  const recipe = await runInOrg(h.db, ORG, (tx) =>
    createRecipe(tx, ORG, { name: 'Thin Margin Cake', sellingPriceCents: 1000 }),
  );
  const added = await runInOrg(h.db, ORG, (tx) =>
    addRecipeIngredient(tx, ORG, { recipeId: recipe.id, ingredientId: ing.id, quantity: 1 }),
  );
  if (!added.ok) throw new Error('failed to add line');
  const findings = await runInOrg(h.db, ORG, (tx) => loadProfitLeaks(tx, ORG));
  const finding = findings.find((f) => f.type === 'RECIPE_BELOW_TARGET_MARGIN');
  if (!finding) throw new Error('expected a below-target finding');
  return finding.fingerprint;
}

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  h.db = test.db as unknown as TenantDb;
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  h.manager = true;
  h.monthlyLimit = 10;
  h.behavior = 'ok';
  h.explainCalls = 0;
  // Clear sidecar + attempt rows between cases (findings are recomputed).
  await h.db.delete(profitInsights).where(eq(profitInsights.organizationId, ORG));
  await h.db.delete(aiOperationAttempts).where(eq(aiOperationAttempts.organizationId, ORG));
});

describe('explainProfitLeakAction', () => {
  it('unknown fingerprint → NOT_FOUND and the provider is never called', async () => {
    await seedFinding();
    const res = await explainProfitLeakAction('deadbeef');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('NOT_FOUND');
    expect(h.explainCalls).toBe(0);
  });

  it('explains a real finding, then serves the cache without a second provider call', async () => {
    const fp = await seedFinding();

    const first = await explainProfitLeakAction(fp);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.data.cached).toBe(false);
      expect(first.data.explanation.riskLevel).toBe('medium');
    }
    expect(h.explainCalls).toBe(1);

    const second = await explainProfitLeakAction(fp);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data.cached).toBe(true);
    // Cache hit → provider NOT called again.
    expect(h.explainCalls).toBe(1);

    // A single succeeded attempt was recorded with usage.
    const attempts = await h.db
      .select()
      .from(aiOperationAttempts)
      .where(eq(aiOperationAttempts.organizationId, ORG));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('succeeded');
    expect(attempts[0]?.feature).toBe('profit_leak_explanation');
    expect(attempts[0]?.resultType).toBe('profit_insight');
  });

  it('monthly cap exhausted → USAGE_LIMIT_REACHED, finding still derivable, no call', async () => {
    const fp = await seedFinding();
    h.monthlyLimit = 0;
    const res = await explainProfitLeakAction(fp);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('USAGE_LIMIT_REACHED');
    expect(h.explainCalls).toBe(0);

    // The deterministic finding is untouched (still surfaces on the next read).
    const findings = await runInOrg(h.db, ORG, (tx) => loadProfitLeaks(tx, ORG));
    expect(findings.some((f) => f.fingerprint === fp)).toBe(true);
  });

  it('provider failure → AI_EXPLAIN_FAILED, a failed attempt is recorded, finding stays', async () => {
    const fp = await seedFinding();
    h.behavior = 'fail';
    const res = await explainProfitLeakAction(fp);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('AI_EXPLAIN_FAILED');

    const attempts = await h.db
      .select()
      .from(aiOperationAttempts)
      .where(eq(aiOperationAttempts.organizationId, ORG));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('failed');
    expect(attempts[0]?.errorCode).toBe('AI_EXPLAIN_FAILED');

    // No explanation cached; finding still visible.
    const rows = await h.db
      .select()
      .from(profitInsights)
      .where(eq(profitInsights.organizationId, ORG));
    expect(rows.every((r) => r.explanation === null)).toBe(true);
  });

  it('transient overload → AI_EXPLAIN_BUSY (retryable code)', async () => {
    const fp = await seedFinding();
    h.behavior = 'busy';
    const res = await explainProfitLeakAction(fp);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('AI_EXPLAIN_BUSY');
  });

  it('kitchen → FORBIDDEN before any provider call', async () => {
    const fp = await seedFinding();
    h.manager = false;
    const res = await explainProfitLeakAction(fp);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('FORBIDDEN');
    expect(h.explainCalls).toBe(0);
  });
});

describe('dismiss / restore actions', () => {
  it('manager dismisses then restores a finding', async () => {
    const fp = await seedFinding();

    const dismissed = await dismissInsightAction(fp);
    expect(dismissed.ok).toBe(true);
    const [afterDismiss] = await h.db
      .select({ dismissedAt: profitInsights.dismissedAt })
      .from(profitInsights)
      .where(eq(profitInsights.fingerprint, fp));
    expect(afterDismiss?.dismissedAt).not.toBeNull();

    const restored = await restoreInsightAction(fp);
    expect(restored.ok).toBe(true);
    const [afterRestore] = await h.db
      .select({ dismissedAt: profitInsights.dismissedAt })
      .from(profitInsights)
      .where(eq(profitInsights.fingerprint, fp));
    expect(afterRestore?.dismissedAt).toBeNull();
  });

  it('kitchen cannot dismiss or restore (FORBIDDEN)', async () => {
    const fp = await seedFinding();
    h.manager = false;
    expect((await dismissInsightAction(fp)).ok).toBe(false);
    expect((await restoreInsightAction(fp)).ok).toBe(false);
  });

  it('unknown fingerprint → NOT_FOUND', async () => {
    await seedFinding();
    const res = await dismissInsightAction('deadbeef');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('NOT_FOUND');
  });
});
