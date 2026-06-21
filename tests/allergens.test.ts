import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import {
  ingredients,
  recipes,
  recipeIngredients,
  ingredientAllergens,
  auditLog,
} from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  replaceIngredientAllergens,
  addOrEscalateRecipeOverride,
  clearRecipeOverride,
  loadRecipeAllergenRollup,
  getIngredientAllergens,
  type AllergenTag,
} from '@/lib/data/allergens';

/**
 * Allergens (Sprint 9). Proves the safety invariants HARD under a real Postgres
 * (PGlite) with RLS active as `tenant_app`: ingredient tags roll up onto recipes
 * (including a trashed ingredient), the atomic replace + review stamp is all-or-
 * nothing, overrides only add/escalate, clear never hides a derived allergen, every
 * mutation is audited with the reviewer (no PII), and cross-org access is blocked.
 */
const ORG_A = 'org_a';
const ORG_B = 'org_b';

const FLOUR = 'ing_flour';
const MILK = 'ing_milk';
const CAKE = 'rec_cake';
const B_ING = 'ing_b';
const B_REC = 'rec_b';

const h = vi.hoisted(() => ({
  db: null as unknown,
  manager: true,
  orgId: 'org_a',
  userId: 'user_1',
}));

vi.mock('@/lib/auth', () => ({
  isManager: vi.fn(async () => h.manager),
  getOrgId: vi.fn(async () => h.orgId),
  getUserId: vi.fn(async () => h.userId),
  getUserRole: vi.fn(async () => (h.manager ? 'manager' : 'kitchen')),
}));

vi.mock('@/lib/db', () => ({
  getDb: () => h.db,
  withOrg: async (org: string, fn: (tx: unknown) => unknown) => {
    const { runInOrg: rio } = await import('@/lib/db/tenant');
    return rio(h.db as TenantDb, org, fn as never);
  },
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { setIngredientAllergensAction } from '@/app/(app)/ingredients/allergen-actions';
import {
  addRecipeOverrideAction,
  clearRecipeOverrideAction,
} from '@/app/(app)/recipes/allergen-actions';

let client: PGlite;
let db: TenantDb;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  h.db = db;
  await db.execute(sql.raw('SET ROLE tenant_app;'));

  await runInOrg(db, ORG_A, async (tx) => {
    await tx.insert(ingredients).values([
      { id: FLOUR, organizationId: ORG_A, name: 'Flour', dimension: 'weight', priceCents: 100 },
      { id: MILK, organizationId: ORG_A, name: 'Milk', dimension: 'volume', priceCents: 90 },
    ]);
    await tx.insert(recipes).values({ id: CAKE, organizationId: ORG_A, name: 'Cake' });
    await tx.insert(recipeIngredients).values([
      { organizationId: ORG_A, recipeId: CAKE, ingredientId: FLOUR, quantity: '500', sortOrder: 0 },
      { organizationId: ORG_A, recipeId: CAKE, ingredientId: MILK, quantity: '250', sortOrder: 1 },
    ]);
  });

  await runInOrg(db, ORG_B, async (tx) => {
    await tx.insert(ingredients).values({
      id: B_ING, organizationId: ORG_B, name: 'B flour', dimension: 'weight', priceCents: 50,
    });
    await tx.insert(recipes).values({ id: B_REC, organizationId: ORG_B, name: 'B cake' });
  });
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

beforeEach(async () => {
  h.manager = true;
  h.orgId = ORG_A;
  h.userId = 'user_1';
  vi.clearAllMocks();
  // Reset allergen state between tests.
  await runInOrg(db, ORG_A, async (tx) => {
    await tx.delete(ingredientAllergens).where(eq(ingredientAllergens.organizationId, ORG_A));
    await tx
      .update(ingredients)
      .set({ allergensReviewedAt: null, allergensReviewedBy: null })
      .where(eq(ingredients.organizationId, ORG_A));
    // NOTE: audit_log is append-only (no DELETE policy under FORCE RLS), so it can't
    // be reset here — audit assertions filter by entityId/action instead of count.
  });
});

const tags = (...t: AllergenTag[]): AllergenTag[] => t;

describe('replaceIngredientAllergens + rollup', () => {
  it('reflects ingredient tags on the recipe rollup', async () => {
    await runInOrg(db, ORG_A, (tx) =>
      replaceIngredientAllergens(tx, ORG_A, FLOUR, tags({ allergen: 'cereals_gluten', presence: 'contains' }), 'user_1'),
    );
    await runInOrg(db, ORG_A, (tx) =>
      replaceIngredientAllergens(tx, ORG_A, MILK, tags({ allergen: 'milk', presence: 'contains' }), 'user_1'),
    );

    const rollup = await runInOrg(db, ORG_A, (tx) => loadRecipeAllergenRollup(tx, ORG_A, CAKE));
    expect(rollup.allergens.map((a) => a.allergen)).toEqual(['cereals_gluten', 'milk']);
    expect(rollup.allergens.every((a) => a.effectivePresence === 'contains')).toBe(true);
    expect(rollup.hasUnreviewedIngredient).toBe(false);
  });

  it('a trashed ingredient still contributes its allergens', async () => {
    await runInOrg(db, ORG_A, (tx) =>
      replaceIngredientAllergens(tx, ORG_A, MILK, tags({ allergen: 'milk', presence: 'contains' }), 'user_1'),
    );
    // Trash the milk ingredient directly (bypassing the in-use guard, to model a
    // referenced-but-trashed row).
    await runInOrg(db, ORG_A, (tx) =>
      tx.update(ingredients).set({ deletedAt: new Date() }).where(
        and(eq(ingredients.organizationId, ORG_A), eq(ingredients.id, MILK)),
      ),
    );
    const rollup = await runInOrg(db, ORG_A, (tx) => loadRecipeAllergenRollup(tx, ORG_A, CAKE));
    expect(rollup.allergens.map((a) => a.allergen)).toContain('milk');
    // Restore for later tests.
    await runInOrg(db, ORG_A, (tx) =>
      tx.update(ingredients).set({ deletedAt: null }).where(
        and(eq(ingredients.organizationId, ORG_A), eq(ingredients.id, MILK)),
      ),
    );
  });

  it('empty replace marks the ingredient reviewed with zero rows', async () => {
    const outcome = await runInOrg(db, ORG_A, (tx) =>
      replaceIngredientAllergens(tx, ORG_A, FLOUR, [], 'user_1'),
    );
    expect(outcome.status).toBe('done');
    const after = await runInOrg(db, ORG_A, async (tx) => {
      const t = await getIngredientAllergens(tx, ORG_A, FLOUR);
      const [row] = await tx
        .select({ at: ingredients.allergensReviewedAt, by: ingredients.allergensReviewedBy })
        .from(ingredients)
        .where(and(eq(ingredients.organizationId, ORG_A), eq(ingredients.id, FLOUR)));
      return { tags: t, row };
    });
    expect(after.tags).toEqual([]);
    expect(after.row?.at).not.toBeNull();
    expect(after.row?.by).toBe('user_1');
  });

  it('rolls back ALL rows and the review stamp on a mid-replace failure', async () => {
    // Seed a known-good reviewed state.
    await runInOrg(db, ORG_A, (tx) =>
      replaceIngredientAllergens(tx, ORG_A, FLOUR, tags({ allergen: 'eggs', presence: 'contains' }), 'user_a'),
    );
    const before = await runInOrg(db, ORG_A, (tx) => getIngredientAllergens(tx, ORG_A, FLOUR));
    expect(before).toEqual([{ allergen: 'eggs', presence: 'contains' }]);

    // A forged invalid presence trips the DB CHECK mid-insert → the whole tx aborts.
    await expect(
      runInOrg(db, ORG_A, (tx) =>
        replaceIngredientAllergens(
          tx,
          ORG_A,
          FLOUR,
          [{ allergen: 'milk', presence: 'definitely' as 'contains' }],
          'user_b',
        ),
      ),
    ).rejects.toThrow();

    const after = await runInOrg(db, ORG_A, async (tx) => {
      const t = await getIngredientAllergens(tx, ORG_A, FLOUR);
      const [row] = await tx
        .select({ by: ingredients.allergensReviewedBy })
        .from(ingredients)
        .where(and(eq(ingredients.organizationId, ORG_A), eq(ingredients.id, FLOUR)));
      return { tags: t, by: row?.by };
    });
    // Nothing partially applied: original tags + original reviewer preserved.
    expect(after.tags).toEqual([{ allergen: 'eggs', presence: 'contains' }]);
    expect(after.by).toBe('user_a');
  });

  it('propagates hasUnreviewedIngredient when a line ingredient is unreviewed', async () => {
    // Only review FLOUR; MILK stays unreviewed.
    await runInOrg(db, ORG_A, (tx) =>
      replaceIngredientAllergens(tx, ORG_A, FLOUR, tags({ allergen: 'cereals_gluten', presence: 'contains' }), 'user_1'),
    );
    const rollup = await runInOrg(db, ORG_A, (tx) => loadRecipeAllergenRollup(tx, ORG_A, CAKE));
    expect(rollup.hasUnreviewedIngredient).toBe(true);
  });
});

describe('recipe overrides — add/escalate only + clear', () => {
  it('adds a new allergen and escalates, but refuses a downgrade/removal', async () => {
    // Derived milk = may_contain from MILK.
    await runInOrg(db, ORG_A, (tx) =>
      replaceIngredientAllergens(tx, ORG_A, MILK, tags({ allergen: 'milk', presence: 'may_contain' }), 'user_1'),
    );

    // Add a brand-new allergen (nuts) → done.
    const add = await runInOrg(db, ORG_A, (tx) =>
      addOrEscalateRecipeOverride(tx, ORG_A, CAKE, 'nuts', 'may_contain'),
    );
    expect(add.status).toBe('done');

    // Escalate milk may_contain → contains → done.
    const esc = await runInOrg(db, ORG_A, (tx) =>
      addOrEscalateRecipeOverride(tx, ORG_A, CAKE, 'milk', 'contains'),
    );
    expect(esc.status).toBe('done');

    // A weaker presence on milk (now contains) is a downgrade → refused, no write.
    const down = await runInOrg(db, ORG_A, (tx) =>
      addOrEscalateRecipeOverride(tx, ORG_A, CAKE, 'milk', 'may_contain'),
    );
    expect(down.status).toBe('cannot_downgrade');

    const rollup = await runInOrg(db, ORG_A, (tx) => loadRecipeAllergenRollup(tx, ORG_A, CAKE));
    expect(rollup.allergens.find((a) => a.allergen === 'milk')?.effectivePresence).toBe('contains');
  });

  it('clear removes a manual addition but the derived allergen still shows', async () => {
    await runInOrg(db, ORG_A, (tx) =>
      replaceIngredientAllergens(tx, ORG_A, MILK, tags({ allergen: 'milk', presence: 'contains' }), 'user_1'),
    );
    // Escalate is a no-op (already contains) → so add an override on a derived one by
    // escalating from a weaker derived. Instead: add nuts (no derived), then clear.
    await runInOrg(db, ORG_A, (tx) =>
      addOrEscalateRecipeOverride(tx, ORG_A, CAKE, 'nuts', 'contains'),
    );
    const cleared = await runInOrg(db, ORG_A, (tx) =>
      clearRecipeOverride(tx, ORG_A, CAKE, 'nuts'),
    );
    expect(cleared.status).toBe('done');

    const rollup = await runInOrg(db, ORG_A, (tx) => loadRecipeAllergenRollup(tx, ORG_A, CAKE));
    // nuts (override-only) is gone; milk (derived) still shows.
    expect(rollup.allergens.map((a) => a.allergen)).toEqual(['milk']);
    expect(rollup.allergens[0]?.effectivePresence).toBe('contains');
  });
});

describe('actions — audit + reviewer, kitchen allowed', () => {
  it('a MANAGER ingredient edit writes an audit row with before/after + actor', async () => {
    h.manager = true;
    h.userId = 'mgr_1';
    const res = await setIngredientAllergensAction(FLOUR, {
      allergens: [{ allergen: 'cereals_gluten', presence: 'contains' }],
    });
    expect(res.ok).toBe(true);

    // audit_log is append-only (no DELETE policy) so filter to THIS ingredient's row.
    const audits = await runInOrg(db, ORG_A, (tx) =>
      tx.select().from(auditLog).where(
        and(
          eq(auditLog.organizationId, ORG_A),
          eq(auditLog.action, 'allergen.ingredientReview'),
          eq(auditLog.entityId, FLOUR),
        ),
      ),
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const row = audits[audits.length - 1]!;
    expect(row.actorUserId).toBe('mgr_1');
    expect(row.actorRole).toBe('manager');
    const metadata = row.metadata as { before: unknown[]; after: { allergen: string }[] };
    expect(metadata.after).toEqual([{ allergen: 'cereals_gluten', presence: 'contains' }]);
    // No free-text reason / PII in metadata.
    expect(JSON.stringify(metadata)).not.toContain('reason');
  });

  it('a KITCHEN user may edit allergens (audited as kitchen)', async () => {
    h.manager = false;
    h.userId = 'kitchen_1';
    const res = await setIngredientAllergensAction(MILK, {
      allergens: [{ allergen: 'milk', presence: 'contains' }],
    });
    expect(res.ok).toBe(true);

    const reviewer = await runInOrg(db, ORG_A, async (tx) => {
      const [row] = await tx
        .select({ by: ingredients.allergensReviewedBy })
        .from(ingredients)
        .where(and(eq(ingredients.organizationId, ORG_A), eq(ingredients.id, MILK)));
      return row?.by;
    });
    expect(reviewer).toBe('kitchen_1');

    const audits = await runInOrg(db, ORG_A, (tx) =>
      tx.select().from(auditLog).where(
        and(
          eq(auditLog.organizationId, ORG_A),
          eq(auditLog.action, 'allergen.ingredientReview'),
          eq(auditLog.entityId, MILK),
        ),
      ),
    );
    expect(audits[audits.length - 1]!.actorRole).toBe('kitchen');
  });

  it('a downgrade override via the action returns ALLERGEN_CANNOT_DOWNGRADE', async () => {
    await runInOrg(db, ORG_A, (tx) =>
      replaceIngredientAllergens(tx, ORG_A, MILK, tags({ allergen: 'milk', presence: 'contains' }), 'user_1'),
    );
    const res = await addRecipeOverrideAction(CAKE, { allergen: 'milk', presence: 'may_contain' });
    expect(res).toEqual({ ok: false, code: 'ALLERGEN_CANNOT_DOWNGRADE' });
  });

  it('override add + clear actions are audited', async () => {
    await addRecipeOverrideAction(CAKE, { allergen: 'sesame', presence: 'contains' });
    await clearRecipeOverrideAction(CAKE, { allergen: 'sesame' });
    const actions = await runInOrg(db, ORG_A, (tx) =>
      tx.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.organizationId, ORG_A)),
    );
    const names = actions.map((a) => a.action);
    expect(names).toContain('allergen.overrideAdd');
    expect(names).toContain('allergen.overrideClear');
  });
});

describe('cross-org isolation', () => {
  it('cannot replace another org ingredient allergens from ORG_A context', async () => {
    const outcome = await runInOrg(db, ORG_A, (tx) =>
      replaceIngredientAllergens(tx, ORG_A, B_ING, tags({ allergen: 'milk', presence: 'contains' }), 'user_1'),
    );
    // RLS hides ORG_B's ingredient → the lock finds nothing → not_found.
    expect(outcome.status).toBe('not_found');
  });

  it('cannot add an override to another org recipe', async () => {
    const outcome = await runInOrg(db, ORG_A, (tx) =>
      addOrEscalateRecipeOverride(tx, ORG_A, B_REC, 'milk', 'contains'),
    );
    expect(outcome.status).toBe('not_found');
  });
});
