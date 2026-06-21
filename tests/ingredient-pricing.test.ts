import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { ingredients, ingredientPriceHistory } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { createIngredient, getIngredientById } from '@/lib/data/ingredients';
import {
  acceptPendingCost,
  appendManualPriceHistory,
  recordPriceObservation,
} from '@/lib/data/ingredient-pricing';

/**
 * Sprint F2 — ingredient pricing services, under the non-privileged `tenant_app`
 * role so RLS is enforced (org_isolation on ingredient_price_history). Proves:
 * observations raise pending WITHOUT touching the approved price; accept moves the
 * price + marks history accepted; org isolation; cascade purge removes history.
 */
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

async function newIngredient(name: string, priceCents = 0): Promise<string> {
  const ing = await runInOrg(db, ORG_A, (tx) =>
    createIngredient(tx, ORG_A, { name, dimension: 'weight', priceCents }),
  );
  return ing.id;
}

// Reads run under the org GUC too (tenant_app + RLS hides rows without it).
function getIng(id: string) {
  return runInOrg(db, ORG_A, (tx) => getIngredientById(tx, ORG_A, id));
}

function historyFor(org: string, ingredientId: string) {
  return runInOrg(db, org, (tx) =>
    tx
      .select()
      .from(ingredientPriceHistory)
      .where(
        and(
          eq(ingredientPriceHistory.organizationId, org),
          eq(ingredientPriceHistory.ingredientId, ingredientId),
        ),
      ),
  );
}

describe('recordPriceObservation', () => {
  it('raises pending_price_cents + logs history WITHOUT changing price_cents', async () => {
    const id = await newIngredient('Flour-obs', 120);

    const result = await runInOrg(db, ORG_A, (tx) =>
      recordPriceObservation(tx, ORG_A, {
        ingredientId: id,
        source: 'order',
        packSize: 5,
        packUnit: 'kg',
        packPriceCents: 2000, // €20 / 5 kg → 400 c/kg
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.derivedPriceCents).toBe(400);

    const ing = await getIng(id);
    // Approved cost untouched; the new cost only sits in pending.
    expect(ing?.priceCents).toBe(120);
    expect(ing?.pendingPriceCents).toBe(400);

    const hist = await historyFor(ORG_A, id);
    expect(hist).toHaveLength(1);
    expect(hist[0]?.accepted).toBe(false);
    expect(hist[0]?.derivedPriceCents).toBe(400);
    expect(hist[0]?.source).toBe('order');
  });

  it('returns not_found for a foreign-org ingredient (no history written)', async () => {
    const id = await newIngredient('Flour-foreign', 100);
    const result = await runInOrg(db, ORG_B, (tx) =>
      recordPriceObservation(tx, ORG_B, {
        ingredientId: id,
        source: 'order',
        packSize: 1,
        packUnit: 'kg',
        packPriceCents: 999,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
    expect(await historyFor(ORG_B, id)).toHaveLength(0);
  });
});

describe('acceptPendingCost', () => {
  it('moves pending into price_cents, clears pending, marks history accepted', async () => {
    const id = await newIngredient('Sugar-accept', 90);
    await runInOrg(db, ORG_A, (tx) =>
      recordPriceObservation(tx, ORG_A, {
        ingredientId: id,
        source: 'quote',
        packSize: 1,
        packUnit: 'kg',
        packPriceCents: 250, // → 250 c/kg
      }),
    );

    const accepted = await runInOrg(db, ORG_A, (tx) =>
      acceptPendingCost(tx, ORG_A, id),
    );
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.ingredient.priceCents).toBe(250);

    const ing = await getIng(id);
    expect(ing?.priceCents).toBe(250);
    expect(ing?.pendingPriceCents).toBeNull();

    const hist = await historyFor(ORG_A, id);
    expect(hist).toHaveLength(1);
    expect(hist[0]?.accepted).toBe(true);
  });

  it('returns nothing_pending when there is no pending cost', async () => {
    const id = await newIngredient('Salt-nopending', 80);
    const result = await runInOrg(db, ORG_A, (tx) =>
      acceptPendingCost(tx, ORG_A, id),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('nothing_pending');
  });

  it('clears needs_pricing when accepting a real (>0) cost', async () => {
    // Unpriced import-style ingredient (price 0, needs pricing).
    const id = await runInOrg(db, ORG_A, async (tx) => {
      const ing = await createIngredient(tx, ORG_A, {
        name: 'Yeast-unpriced',
        dimension: 'weight',
        priceCents: 0,
        needsPricing: true,
      });
      return ing.id;
    });
    await runInOrg(db, ORG_A, (tx) =>
      recordPriceObservation(tx, ORG_A, {
        ingredientId: id,
        source: 'order',
        packSize: 1,
        packUnit: 'kg',
        packPriceCents: 1600,
      }),
    );
    await runInOrg(db, ORG_A, (tx) => acceptPendingCost(tx, ORG_A, id));

    const ing = await getIng(id);
    expect(ing?.priceCents).toBe(1600);
    expect(ing?.needsPricing).toBe(false);
  });
});

describe('appendManualPriceHistory + cascade purge', () => {
  it('writes an accepted manual row, and ingredient purge cascade-deletes history', async () => {
    const id = await newIngredient('Butter-manual', 950);
    await runInOrg(db, ORG_A, (tx) =>
      appendManualPriceHistory(tx, ORG_A, id, 950, 'user_1'),
    );
    const hist = await historyFor(ORG_A, id);
    expect(hist).toHaveLength(1);
    expect(hist[0]?.source).toBe('manual');
    expect(hist[0]?.accepted).toBe(true);

    // Hard-delete the ingredient → history cascade-deletes with it.
    await runInOrg(db, ORG_A, (tx) =>
      tx
        .delete(ingredients)
        .where(and(eq(ingredients.organizationId, ORG_A), eq(ingredients.id, id))),
    );
    expect(await historyFor(ORG_A, id)).toHaveLength(0);
  });
});
