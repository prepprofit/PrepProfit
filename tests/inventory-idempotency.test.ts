import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { ingredients, inventoryMovements } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { createIngredient } from '@/lib/data/ingredients';
import {
  MovementError,
  listMovements,
  recordMovement,
  recordMovements,
} from '@/lib/data/inventory';

/**
 * Sprint F1 — inventory ledger idempotency, reversal and append-only guarantees.
 *
 * Runs against a real in-memory Postgres (PGlite) under the non-privileged
 * `tenant_app` role so RLS (incl. the new append-only policy on
 * inventory_movements) is actually enforced — the superuser bypasses FORCE RLS.
 *
 * The action-level case (mandatory criterion #2) exercises `recordMovementAction`
 * end-to-end: `@/lib/auth` and `@/lib/db` are mocked so the action runs against
 * THIS test db (the client-generated mutationId is the only idempotency input).
 */
const ORG = 'org_idem';

const h = vi.hoisted(() => ({
  db: null as unknown as TenantDb,
  org: 'org_idem',
}));

vi.mock('@/lib/auth', () => ({
  getOrgId: vi.fn(async () => h.org),
  // `recordMovementAction` now resolves an actor (audit F-06) → getUserId/Role.
  getUserId: vi.fn(async () => 'user_test'),
  getUserRole: vi.fn(async () => 'manager'),
}));

// withOrg → run the fn against the SAME PGlite db (as tenant_app, RLS active),
// instead of the production Neon pool. runInOrg sets the org GUC per transaction.
// getDb is only the rate-limiter's handle here, which the mock below short-circuits.
vi.mock('@/lib/db', async () => {
  const { runInOrg: realRunInOrg } = await import('@/lib/db/tenant');
  return {
    getDb: () => h.db,
    withOrg: (org: string, fn: (tx: never) => unknown) =>
      realRunInOrg(h.db, org, fn as never),
  };
});

// The `inventory` rate-limit bucket (audit F-05) is proven in the limiter's own
// suite; here we always allow so the idempotency assertions stay isolated.
vi.mock('@/lib/rate-limit', () => ({
  enforceRateLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { recordMovementAction } from '@/app/(app)/inventory/actions';

let client: PGlite;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  h.db = test.db as unknown as TenantDb;
  // Enforce RLS for the whole file (superuser would bypass FORCE RLS).
  await h.db.execute(sql.raw('SET ROLE tenant_app;'));
});

afterAll(async () => {
  await h.db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

/** Helper: new active ingredient in ORG. */
async function newIngredient(name: string): Promise<string> {
  const ing = await runInOrg(h.db, ORG, (tx) =>
    createIngredient(tx, ORG, { name, dimension: 'weight', priceCents: 100 }),
  );
  return ing.id;
}

/** Helper: this org's movements for an ingredient (read under the org GUC). */
function movementsFor(ingredientId: string) {
  return runInOrg(h.db, ORG, (tx) => listMovements(tx, ORG, ingredientId));
}

describe('recordMovementAction — client mutationId idempotency (criterion #2)', () => {
  it('a double-submit with the same mutationId applies exactly one movement', async () => {
    const ingredientId = await newIngredient('Flour-action');
    const mutationId = crypto.randomUUID();

    const first = await recordMovementAction({
      ingredientId,
      deltaCanonical: 1000,
      mutationId,
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.data.stockQuantity).toBe(1000);

    // Same client id (a retry / double-click) → the server dedups, never doubles.
    const second = await recordMovementAction({
      ingredientId,
      deltaCanonical: 1000,
      mutationId,
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data.stockQuantity).toBe(1000); // NOT 2000

    const ledger = await movementsFor(ingredientId);
    expect(ledger).toHaveLength(1);
  });

  it('maps a same-key / different-payload reuse to IDEMPOTENCY_CONFLICT', async () => {
    const ingredientId = await newIngredient('Flour-action-conflict');
    const mutationId = crypto.randomUUID();

    const first = await recordMovementAction({
      ingredientId,
      deltaCanonical: 500,
      mutationId,
    });
    expect(first.ok).toBe(true);

    // Same mutationId, different delta → a genuine conflict, not a silent dedup.
    const clash = await recordMovementAction({
      ingredientId,
      deltaCanonical: 900,
      mutationId,
    });
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.code).toBe('IDEMPOTENCY_CONFLICT');

    const ledger = await movementsFor(ingredientId);
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0]?.deltaCanonical)).toBe(500);
  });
});

describe('recordMovement — dedup vs conflict (data layer)', () => {
  it('a repeated key with an identical payload is deduped (no second stock move)', async () => {
    const ingredientId = await newIngredient('Sugar-dedup');
    const key = 'manual:dedup-1';

    const r1 = await runInOrg(h.db, ORG, (tx) =>
      recordMovement(tx, ORG, {
        ingredientId,
        deltaCanonical: 500,
        source: { type: 'manual' },
        idempotencyKey: key,
      }),
    );
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.deduped).toBeUndefined();
      expect(Number(r1.ingredient.stockQuantity)).toBe(500);
    }

    const r2 = await runInOrg(h.db, ORG, (tx) =>
      recordMovement(tx, ORG, {
        ingredientId,
        deltaCanonical: 500,
        source: { type: 'manual' },
        idempotencyKey: key,
      }),
    );
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.deduped).toBe(true);
      expect(Number(r2.ingredient.stockQuantity)).toBe(500); // unchanged
    }

    expect(await movementsFor(ingredientId)).toHaveLength(1);
  });

  it('the same key with a different payload returns idempotency_conflict', async () => {
    const ingredientId = await newIngredient('Sugar-conflict');
    const key = 'manual:conflict-1';

    await runInOrg(h.db, ORG, (tx) =>
      recordMovement(tx, ORG, {
        ingredientId,
        deltaCanonical: 500,
        source: { type: 'manual' },
        idempotencyKey: key,
      }),
    );

    const clash = await runInOrg(h.db, ORG, (tx) =>
      recordMovement(tx, ORG, {
        ingredientId,
        deltaCanonical: 250,
        source: { type: 'manual' },
        idempotencyKey: key,
      }),
    );
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.reason).toBe('idempotency_conflict');

    expect(await movementsFor(ingredientId)).toHaveLength(1);
  });
});

describe('recordMovement — insufficient stock leaves no orphan', () => {
  it('a rejected stock-out writes ZERO movements', async () => {
    const ingredientId = await newIngredient('Salt-orphan');

    const result = await runInOrg(h.db, ORG, (tx) =>
      recordMovement(tx, ORG, {
        ingredientId,
        deltaCanonical: -100,
        source: { type: 'manual' },
        idempotencyKey: 'manual:orphan-1',
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('insufficient_stock');

    expect(await movementsFor(ingredientId)).toHaveLength(0);
  });
});

describe('recordMovements — batch rolls back fully on mid-batch failure', () => {
  it('a mid-batch insufficient_stock throws and leaves ZERO new movements', async () => {
    const a = await newIngredient('Batch-A');
    const b = await newIngredient('Batch-B');

    // A has stock; B has none.
    await runInOrg(h.db, ORG, (tx) =>
      recordMovement(tx, ORG, {
        ingredientId: a,
        deltaCanonical: 1000,
        source: { type: 'manual' },
        idempotencyKey: 'manual:batch-a-opening',
      }),
    );

    // One withOrg: consume from A (ok) AND from B (fails). The throw rolls the
    // whole transaction back, so A's in-batch consumption is undone too.
    await expect(
      runInOrg(h.db, ORG, (tx) =>
        recordMovements(tx, ORG, [
          {
            ingredientId: a,
            deltaCanonical: -200,
            source: { type: 'production', id: 'prod_1', lineId: 'l_a' },
            idempotencyKey: 'production:prod_1:l_a:' + a,
          },
          {
            ingredientId: b,
            deltaCanonical: -100,
            source: { type: 'production', id: 'prod_1', lineId: 'l_b' },
            idempotencyKey: 'production:prod_1:l_b:' + b,
          },
        ]),
      ),
    ).rejects.toBeInstanceOf(MovementError);

    // A unchanged (still 1000, only its opening movement); B never moved.
    const stockA = await runInOrg(h.db, ORG, async (tx) => {
      const [row] = await tx
        .select({ stock: ingredients.stockQuantity })
        .from(ingredients)
        .where(and(eq(ingredients.organizationId, ORG), eq(ingredients.id, a)))
        .limit(1);
      return Number(row?.stock);
    });
    expect(stockA).toBe(1000);
    expect(await movementsFor(a)).toHaveLength(1); // opening only
    expect(await movementsFor(b)).toHaveLength(0);
  });
});

describe('recordMovement — reversal', () => {
  it('a reversal nets back to the prior balance', async () => {
    const ingredientId = await newIngredient('Yeast-reversal');

    await runInOrg(h.db, ORG, (tx) =>
      recordMovement(tx, ORG, {
        ingredientId,
        deltaCanonical: 1000,
        source: { type: 'manual' },
        idempotencyKey: 'manual:rev-opening',
      }),
    );
    const consume = await runInOrg(h.db, ORG, (tx) =>
      recordMovement(tx, ORG, {
        ingredientId,
        deltaCanonical: -300,
        source: { type: 'production', id: 'prod_rev', lineId: 'l1' },
        idempotencyKey: 'production:prod_rev:l1:' + ingredientId,
      }),
    );
    expect(consume.ok).toBe(true);

    // The movement to undo (newest first).
    const [toReverse] = await movementsFor(ingredientId);
    expect(Number(toReverse?.deltaCanonical)).toBe(-300);

    const reversed = await runInOrg(h.db, ORG, (tx) =>
      recordMovement(tx, ORG, {
        ingredientId,
        deltaCanonical: 300,
        source: { type: 'reversal' },
        idempotencyKey: 'reversal:' + toReverse!.id,
        reversalOf: toReverse!.id,
      }),
    );
    expect(reversed.ok).toBe(true);
    if (reversed.ok) expect(Number(reversed.ingredient.stockQuantity)).toBe(1000);
  });

  it('a second DISTINCT reversal of the same movement is rejected (partial unique)', async () => {
    const ingredientId = await newIngredient('Yeast-double-reversal');

    await runInOrg(h.db, ORG, (tx) =>
      recordMovement(tx, ORG, {
        ingredientId,
        deltaCanonical: 1000,
        source: { type: 'manual' },
        idempotencyKey: 'manual:dr-opening',
      }),
    );
    const consume = await runInOrg(h.db, ORG, (tx) =>
      recordMovement(tx, ORG, {
        ingredientId,
        deltaCanonical: -200,
        source: { type: 'production', id: 'prod_dr', lineId: 'l1' },
        idempotencyKey: 'production:prod_dr:l1:' + ingredientId,
      }),
    );
    expect(consume.ok).toBe(true);
    const [toReverse] = await movementsFor(ingredientId);

    const first = await runInOrg(h.db, ORG, (tx) =>
      recordMovement(tx, ORG, {
        ingredientId,
        deltaCanonical: 200,
        source: { type: 'reversal' },
        idempotencyKey: 'reversal:' + toReverse!.id,
        reversalOf: toReverse!.id,
      }),
    );
    expect(first.ok).toBe(true);

    // A genuinely different reversal attempt (distinct key) for the SAME movement
    // hits the partial unique on (org, reversal_of) → the DB raises.
    await expect(
      runInOrg(h.db, ORG, (tx) =>
        recordMovement(tx, ORG, {
          ingredientId,
          deltaCanonical: 200,
          source: { type: 'reversal' },
          idempotencyKey: 'reversal:' + toReverse!.id + ':again',
          reversalOf: toReverse!.id,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('inventory_movements — append-only RLS', () => {
  it('UPDATE and DELETE affect zero rows, but ingredient cascade-purge removes movements', async () => {
    const ingredientId = await newIngredient('Cream-appendonly');
    await runInOrg(h.db, ORG, (tx) =>
      recordMovement(tx, ORG, {
        ingredientId,
        deltaCanonical: 600,
        source: { type: 'manual' },
        idempotencyKey: 'manual:ao-1',
      }),
    );

    // No UPDATE/DELETE policy under FORCE RLS → these match zero rows.
    const updated = await runInOrg(h.db, ORG, (tx) =>
      tx
        .update(inventoryMovements)
        .set({ note: 'tampered' })
        .where(eq(inventoryMovements.organizationId, ORG))
        .returning({ id: inventoryMovements.id }),
    );
    expect(updated).toHaveLength(0);

    const deleted = await runInOrg(h.db, ORG, (tx) =>
      tx
        .delete(inventoryMovements)
        .where(eq(inventoryMovements.organizationId, ORG))
        .returning({ id: inventoryMovements.id }),
    );
    expect(deleted).toHaveLength(0);

    // The movement survived the tamper attempts.
    expect(await movementsFor(ingredientId)).toHaveLength(1);

    // Purging the ingredient cascade-deletes its movements (cascade is a
    // referential action, exempt from the child table's append-only RLS).
    await runInOrg(h.db, ORG, (tx) =>
      tx
        .delete(ingredients)
        .where(and(eq(ingredients.organizationId, ORG), eq(ingredients.id, ingredientId))),
    );
    expect(await movementsFor(ingredientId)).toHaveLength(0);
  });
});
