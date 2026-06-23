import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { runInOrg, type TenantDb } from '@/lib/db/tenant';
import {
  ingredients as ingredientsTable,
  inventoryMovements,
  stockCountItems,
  stockCounts as stockCountsTable,
  storageAreas as storageAreasTable,
} from '@/lib/db/schema';
import { createIngredient, getIngredientById, softDeleteIngredient } from '@/lib/data/ingredients';
import { recordMovement } from '@/lib/data/inventory';
import {
  createArea,
  ensureDefaultArea,
  getDefaultArea,
  softDeleteArea,
} from '@/lib/data/storage-areas';
import {
  areaBalanceOf,
  commitStockCount,
  createStockCount,
  transferStock,
  updateStockCount,
  type ResolvedArea,
} from '@/lib/data/inventory-areas';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

let client: PGlite;
let db: TenantDb;

/** Reset all 12c + ledger tables so each test starts clean. */
async function reset(): Promise<void> {
  await db.delete(stockCountItems);
  await db.delete(stockCountsTable);
  await db.delete(inventoryMovements);
  await db.delete(ingredientsTable);
  await db.delete(storageAreasTable);
}

beforeEach(async () => {
  if (!db) {
    const test = await createTestDb();
    client = test.client;
    db = test.db as unknown as TenantDb;
  }
  await reset();
});

afterAll(async () => {
  await client.close();
});

async function newIngredient(name = 'Flour'): Promise<string> {
  const ing = await createIngredient(db, ORG_A, { name, dimension: 'weight', priceCents: 100 });
  return ing.id;
}

function resolved(area: { id: string; isDefault: boolean }): ResolvedArea {
  return { id: area.id, isDefault: area.isDefault };
}

describe('balance invariant', () => {
  it('a transfer keeps stock_quantity, moves the area split, and reconciles', async () => {
    const ingredientId = await newIngredient();
    const def = await ensureDefaultArea(db, ORG_A);
    const bar = (await createArea(db, ORG_A, 'Bar')) as { status: 'ok'; area: { id: string; isDefault: boolean } };

    // Opening: 100 into the default area.
    await recordMovement(db, ORG_A, {
      ingredientId,
      deltaCanonical: 100,
      source: { type: 'manual' },
      idempotencyKey: 'open',
      storageAreaId: def.id,
    });

    const result = await transferStock(db, ORG_A, {
      ingredientId,
      areaFromId: def.id,
      areaToId: bar.area.id,
      qty: 30,
      clientTransferId: crypto.randomUUID(),
    });
    expect(result.status).toBe('ok');

    const ing = await getIngredientById(db, ORG_A, ingredientId);
    expect(Number(ing?.stockQuantity)).toBe(100); // nets zero at ingredient level
    expect(await areaBalanceOf(db, ORG_A, resolved(def), ingredientId)).toBe(70);
    expect(await areaBalanceOf(db, ORG_A, resolved(bar.area), ingredientId)).toBe(30);
  });
});

describe('transfer ordering (IN first)', () => {
  it('succeeds into the default even when the default/NULL bucket is negative', async () => {
    const ingredientId = await newIngredient();
    const def = await ensureDefaultArea(db, ORG_A);
    const bar = (await createArea(db, ORG_A, 'Bar')) as { status: 'ok'; area: { id: string; isDefault: boolean } };

    // Bar = 50; default NULL bucket = -30 (org total 20). OUT-first would fail org floor.
    await recordMovement(db, ORG_A, {
      ingredientId,
      deltaCanonical: 50,
      source: { type: 'manual' },
      idempotencyKey: 'bar-open',
      storageAreaId: bar.area.id,
    });
    await recordMovement(db, ORG_A, {
      ingredientId,
      deltaCanonical: -30,
      source: { type: 'manual' },
      idempotencyKey: 'default-neg',
      storageAreaId: null, // legacy default bucket
    });

    const result = await transferStock(db, ORG_A, {
      ingredientId,
      areaFromId: bar.area.id,
      areaToId: def.id,
      qty: 40,
      clientTransferId: crypto.randomUUID(),
    });
    expect(result.status).toBe('ok');

    expect(await areaBalanceOf(db, ORG_A, resolved(bar.area), ingredientId)).toBe(10);
    // default = -30 (NULL) + 40 (IN) = 10.
    expect(await areaBalanceOf(db, ORG_A, resolved(def), ingredientId)).toBe(10);
    const ing = await getIngredientById(db, ORG_A, ingredientId);
    expect(Number(ing?.stockQuantity)).toBe(20);
  });
});

describe('per-area floor', () => {
  it('rejects a transfer exceeding the source-area balance, writing no movement', async () => {
    const ingredientId = await newIngredient();
    const def = await ensureDefaultArea(db, ORG_A);
    const bar = (await createArea(db, ORG_A, 'Bar')) as { status: 'ok'; area: { id: string; isDefault: boolean } };

    // Bar = 20, default = 100 (org total 120). Transfer 60 from bar (under org total).
    await recordMovement(db, ORG_A, {
      ingredientId,
      deltaCanonical: 20,
      source: { type: 'manual' },
      idempotencyKey: 'bar-open',
      storageAreaId: bar.area.id,
    });
    await recordMovement(db, ORG_A, {
      ingredientId,
      deltaCanonical: 100,
      source: { type: 'manual' },
      idempotencyKey: 'def-open',
      storageAreaId: def.id,
    });

    const result = await transferStock(db, ORG_A, {
      ingredientId,
      areaFromId: bar.area.id,
      areaToId: def.id,
      qty: 60,
      clientTransferId: crypto.randomUUID(),
    });
    expect(result.status).toBe('insufficient_stock');

    // No transfer movement written.
    const moves = await db
      .select()
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.organizationId, ORG_A),
          eq(inventoryMovements.sourceType, 'transfer'),
        ),
      );
    expect(moves.length).toBe(0);
  });

  it('rejects a self-transfer after resolving the null/default alias', async () => {
    const ingredientId = await newIngredient();
    const def = await ensureDefaultArea(db, ORG_A);
    const result = await transferStock(db, ORG_A, {
      ingredientId,
      areaFromId: null, // resolves to default
      areaToId: def.id, // same area
      qty: 1,
      clientTransferId: crypto.randomUUID(),
    });
    expect(result.status).toBe('same_area');
  });
});

describe('default bucket', () => {
  it('legacy NULL movements count toward the default area balance', async () => {
    const ingredientId = await newIngredient();
    const def = await ensureDefaultArea(db, ORG_A);
    await recordMovement(db, ORG_A, {
      ingredientId,
      deltaCanonical: 42,
      source: { type: 'manual' },
      idempotencyKey: 'legacy',
      storageAreaId: null,
    });
    expect(await areaBalanceOf(db, ORG_A, resolved(def), ingredientId)).toBe(42);
  });
});

describe('count commit', () => {
  it('posts positive and negative deltas, skips zero, records snapshots, ends at counted', async () => {
    const up = await newIngredient('Up');
    const down = await newIngredient('Down');
    const same = await newIngredient('Same');
    const def = await ensureDefaultArea(db, ORG_A);

    // Opening balances in the default area.
    for (const [id, qty, key] of [
      [up, 10, 'up'],
      [down, 50, 'down'],
      [same, 30, 'same'],
    ] as const) {
      await recordMovement(db, ORG_A, {
        ingredientId: id,
        deltaCanonical: qty,
        source: { type: 'manual' },
        idempotencyKey: key,
        storageAreaId: def.id,
      });
    }

    const created = await createStockCount(db, ORG_A, {
      storageAreaId: def.id,
      note: null,
      createdBy: 'u1',
    });
    expect(created.status).toBe('ok');
    if (created.status !== 'ok') return;
    const countId = created.count.id;

    const updated = await updateStockCount(db, ORG_A, countId, created.count.updatedAt, {
      note: null,
      items: [
        { ingredientId: up, countedCanonical: 25 }, // +15
        { ingredientId: down, countedCanonical: 40 }, // -10
        { ingredientId: same, countedCanonical: 30 }, // 0 → no movement
      ],
    });
    expect(updated.status).toBe('ok');
    if (updated.status !== 'ok') return;

    const committed = await commitStockCount(db, ORG_A, countId, updated.count.updatedAt);
    expect(committed.status).toBe('ok');
    if (committed.status !== 'ok') return;
    expect(committed.movementCount).toBe(2); // zero-delta skipped

    expect(Number((await getIngredientById(db, ORG_A, up))?.stockQuantity)).toBe(25);
    expect(Number((await getIngredientById(db, ORG_A, down))?.stockQuantity)).toBe(40);
    expect(Number((await getIngredientById(db, ORG_A, same))?.stockQuantity)).toBe(30);

    const items = await db
      .select()
      .from(stockCountItems)
      .where(eq(stockCountItems.stockCountId, countId));
    const byIngredient = new Map(items.map((i) => [i.ingredientId, i]));
    expect(Number(byIngredient.get(up)?.systemCanonical)).toBe(10);
    expect(byIngredient.get(up)?.movementId).not.toBeNull();
    expect(byIngredient.get(same)?.movementId).toBeNull(); // zero-delta: no movement
  });

  it('computes the adjustment against the LIVE balance at commit (timing gap)', async () => {
    const ingredientId = await newIngredient();
    const def = await ensureDefaultArea(db, ORG_A);
    await recordMovement(db, ORG_A, {
      ingredientId,
      deltaCanonical: 100,
      source: { type: 'manual' },
      idempotencyKey: 'open',
      storageAreaId: def.id,
    });

    const created = await createStockCount(db, ORG_A, { storageAreaId: def.id, note: null, createdBy: null });
    if (created.status !== 'ok') return;
    const updated = await updateStockCount(db, ORG_A, created.count.id, created.count.updatedAt, {
      note: null,
      items: [{ ingredientId, countedCanonical: 90 }],
    });
    if (updated.status !== 'ok') return;

    // A sale fires between entry and commit: -20 (live balance now 80).
    await recordMovement(db, ORG_A, {
      ingredientId,
      deltaCanonical: -20,
      source: { type: 'manual' },
      idempotencyKey: 'mid',
      storageAreaId: def.id,
    });

    const committed = await commitStockCount(db, ORG_A, created.count.id, updated.count.updatedAt);
    expect(committed.status).toBe('ok');
    // delta = 90 - 80 = +10 → ends at the counted 90, not 70.
    expect(Number((await getIngredientById(db, ORG_A, ingredientId))?.stockQuantity)).toBe(90);
  });

  it('rejects a commit with a trashed counted ingredient, writing no movement', async () => {
    const live = await newIngredient('Live');
    const gone = await newIngredient('Gone');
    const def = await ensureDefaultArea(db, ORG_A);

    const created = await createStockCount(db, ORG_A, { storageAreaId: def.id, note: null, createdBy: null });
    if (created.status !== 'ok') return;
    const updated = await updateStockCount(db, ORG_A, created.count.id, created.count.updatedAt, {
      note: null,
      items: [
        { ingredientId: live, countedCanonical: 5 },
        { ingredientId: gone, countedCanonical: 5 },
      ],
    });
    if (updated.status !== 'ok') return;

    await softDeleteIngredient(db, ORG_A, gone);

    const committed = await commitStockCount(db, ORG_A, created.count.id, updated.count.updatedAt);
    expect(committed.status).toBe('incomplete');

    const moves = await db
      .select()
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.organizationId, ORG_A),
          eq(inventoryMovements.sourceType, 'adjustment'),
        ),
      );
    expect(moves.length).toBe(0);

    // Count stays draft.
    const [row] = await db
      .select()
      .from(stockCountsTable)
      .where(eq(stockCountsTable.id, created.count.id));
    expect(row?.status).toBe('draft');
  });

  it('re-committing a committed count is an idempotent no-op', async () => {
    const ingredientId = await newIngredient();
    const def = await ensureDefaultArea(db, ORG_A);
    await recordMovement(db, ORG_A, {
      ingredientId,
      deltaCanonical: 10,
      source: { type: 'manual' },
      idempotencyKey: 'open',
      storageAreaId: def.id,
    });
    const created = await createStockCount(db, ORG_A, { storageAreaId: def.id, note: null, createdBy: null });
    if (created.status !== 'ok') return;
    const updated = await updateStockCount(db, ORG_A, created.count.id, created.count.updatedAt, {
      note: null,
      items: [{ ingredientId, countedCanonical: 15 }],
    });
    if (updated.status !== 'ok') return;
    const first = await commitStockCount(db, ORG_A, created.count.id, updated.count.updatedAt);
    expect(first.status).toBe('ok');

    const again = await commitStockCount(db, ORG_A, created.count.id, updated.count.updatedAt);
    expect(again.status).toBe('ok');
    if (again.status === 'ok') expect(again.alreadyCommitted).toBe(true);
    // Stock unchanged by the second commit.
    expect(Number((await getIngredientById(db, ORG_A, ingredientId))?.stockQuantity)).toBe(15);
  });
});

describe('transfer idempotency', () => {
  it('a replayed transfer dedups (no second movement)', async () => {
    const ingredientId = await newIngredient();
    const def = await ensureDefaultArea(db, ORG_A);
    const bar = (await createArea(db, ORG_A, 'Bar')) as { status: 'ok'; area: { id: string; isDefault: boolean } };
    await recordMovement(db, ORG_A, {
      ingredientId,
      deltaCanonical: 50,
      source: { type: 'manual' },
      idempotencyKey: 'open',
      storageAreaId: def.id,
    });

    const transferId = crypto.randomUUID();
    const args = { ingredientId, areaFromId: def.id, areaToId: bar.area.id, qty: 20, clientTransferId: transferId };
    const first = await transferStock(db, ORG_A, args);
    expect(first.status).toBe('ok');
    const second = await transferStock(db, ORG_A, args);
    expect(second.status).toBe('ok');
    if (second.status === 'ok') expect(second.deduped).toBe(true);

    expect(await areaBalanceOf(db, ORG_A, resolved(bar.area), ingredientId)).toBe(20); // not 40
  });

  it('the same idempotency key with a different storage area is a conflict', async () => {
    const ingredientId = await newIngredient();
    const def = await ensureDefaultArea(db, ORG_A);
    const bar = (await createArea(db, ORG_A, 'Bar')) as { status: 'ok'; area: { id: string; isDefault: boolean } };

    const first = await recordMovement(db, ORG_A, {
      ingredientId,
      deltaCanonical: 10,
      source: { type: 'manual' },
      idempotencyKey: 'dup',
      storageAreaId: def.id,
    });
    expect(first.ok).toBe(true);

    const conflict = await recordMovement(db, ORG_A, {
      ingredientId,
      deltaCanonical: 10,
      source: { type: 'manual' },
      idempotencyKey: 'dup',
      storageAreaId: bar.area.id, // different area, same key
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.reason).toBe('idempotency_conflict');
  });
});

describe('append-only + purge', () => {
  it('an ingredient purge removes its movements but leaves count items as history', async () => {
    const ingredientId = await newIngredient();
    const def = await ensureDefaultArea(db, ORG_A);
    await recordMovement(db, ORG_A, {
      ingredientId,
      deltaCanonical: 20,
      source: { type: 'manual' },
      idempotencyKey: 'open',
      storageAreaId: def.id,
    });
    const created = await createStockCount(db, ORG_A, { storageAreaId: def.id, note: null, createdBy: null });
    if (created.status !== 'ok') return;
    const updated = await updateStockCount(db, ORG_A, created.count.id, created.count.updatedAt, {
      note: null,
      items: [{ ingredientId, countedCanonical: 25 }],
    });
    if (updated.status !== 'ok') return;
    await commitStockCount(db, ORG_A, created.count.id, updated.count.updatedAt);

    // Hard-purge the ingredient (cascades inventory_movements).
    await db.delete(ingredientsTable).where(eq(ingredientsTable.id, ingredientId));

    const moves = await db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.ingredientId, ingredientId));
    expect(moves.length).toBe(0);

    const items = await db
      .select()
      .from(stockCountItems)
      .where(eq(stockCountItems.ingredientId, ingredientId));
    expect(items.length).toBe(1); // provenance survives (no live FK)
  });

  it('RLS blocks UPDATE/DELETE of an area movement (append-only)', async () => {
    const ingredientId = await newIngredient();
    const def = await ensureDefaultArea(db, ORG_A);
    const [move] = await db
      .insert(inventoryMovements)
      .values({
        organizationId: ORG_A,
        ingredientId,
        deltaCanonical: '5',
        sourceType: 'manual',
        idempotencyKey: 'rls',
        storageAreaId: def.id,
      })
      .returning();

    await db.execute(sql.raw('SET ROLE tenant_app;'));
    try {
      const updated = await runInOrg(db, ORG_A, (tx) =>
        tx
          .update(inventoryMovements)
          .set({ deltaCanonical: '999' })
          .where(eq(inventoryMovements.id, move!.id))
          .returning(),
      );
      expect(updated.length).toBe(0);
      const deleted = await runInOrg(db, ORG_A, (tx) =>
        tx
          .delete(inventoryMovements)
          .where(eq(inventoryMovements.id, move!.id))
          .returning(),
      );
      expect(deleted.length).toBe(0);
    } finally {
      await db.execute(sql.raw('RESET ROLE;'));
    }
  });
});

describe('area delete guards', () => {
  it('refuses the default area, a non-empty area, and a draft-referenced area', async () => {
    const ingredientId = await newIngredient();
    const def = await getDefaultArea(db, ORG_A) ?? (await ensureDefaultArea(db, ORG_A));
    const bar = (await createArea(db, ORG_A, 'Bar')) as { status: 'ok'; area: { id: string; isDefault: boolean; updatedAt: Date } };

    // Default refused.
    const defResult = await softDeleteArea(db, ORG_A, def.id, def.updatedAt);
    expect(defResult.status).toBe('default_locked');

    // Non-empty refused.
    await recordMovement(db, ORG_A, {
      ingredientId,
      deltaCanonical: 5,
      source: { type: 'manual' },
      idempotencyKey: 'bar-stock',
      storageAreaId: bar.area.id,
    });
    const nonEmpty = await softDeleteArea(db, ORG_A, bar.area.id, bar.area.updatedAt);
    expect(nonEmpty.status).toBe('not_empty');

    // Move it back to zero, then a draft count pins it.
    await recordMovement(db, ORG_A, {
      ingredientId,
      deltaCanonical: -5,
      source: { type: 'manual' },
      idempotencyKey: 'bar-zero',
      storageAreaId: bar.area.id,
    });
    await createStockCount(db, ORG_A, { storageAreaId: bar.area.id, note: null, createdBy: null });
    const withDraft = await softDeleteArea(db, ORG_A, bar.area.id, bar.area.updatedAt);
    expect(withDraft.status).toBe('has_draft_count');
  });

  it('soft-deletes an empty, draft-free non-default area', async () => {
    const bar = (await createArea(db, ORG_A, 'Bar')) as { status: 'ok'; area: { id: string; isDefault: boolean; updatedAt: Date } };
    const result = await softDeleteArea(db, ORG_A, bar.area.id, bar.area.updatedAt);
    expect(result.status).toBe('ok');
  });
});

describe('org isolation (RLS)', () => {
  it('isolates storage_areas / stock_counts / stock_count_items across orgs', async () => {
    // Seed one area + one draft count + item per org (superuser bypasses RLS).
    const defA = await ensureDefaultArea(db, ORG_A);
    const defB = await ensureDefaultArea(db, ORG_B);
    const countA = await createStockCount(db, ORG_A, { storageAreaId: defA.id, note: null, createdBy: null });
    const countB = await createStockCount(db, ORG_B, { storageAreaId: defB.id, note: null, createdBy: null });
    if (countA.status !== 'ok' || countB.status !== 'ok') throw new Error('seed failed');

    await db.execute(sql.raw('SET ROLE tenant_app;'));
    try {
      // SELECT isolation: A sees only its own area + count.
      const seen = await runInOrg(db, ORG_A, async (tx) => ({
        areas: await tx.select().from(storageAreasTable),
        counts: await tx.select().from(stockCountsTable),
      }));
      expect(seen.areas.every((a) => a.organizationId === ORG_A)).toBe(true);
      expect(seen.counts.every((c) => c.organizationId === ORG_A)).toBe(true);

      // INSERT WITH CHECK: A cannot insert a row tagged for B.
      await expect(
        runInOrg(db, ORG_A, (tx) =>
          tx.insert(storageAreasTable).values({ organizationId: ORG_B, name: 'Sneaky' }),
        ),
      ).rejects.toThrow();

      // UPDATE retag: A cannot move B's count into A.
      const retag = await runInOrg(db, ORG_A, (tx) =>
        tx
          .update(stockCountsTable)
          .set({ note: 'x' })
          .where(eq(stockCountsTable.id, countB.count.id))
          .returning(),
      );
      expect(retag.length).toBe(0);

      // DELETE reachability: A cannot delete B's area.
      const del = await runInOrg(db, ORG_A, (tx) =>
        tx.delete(storageAreasTable).where(eq(storageAreasTable.id, defB.id)).returning(),
      );
      expect(del.length).toBe(0);
    } finally {
      await db.execute(sql.raw('RESET ROLE;'));
    }
  });
});
