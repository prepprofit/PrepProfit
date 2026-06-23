import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  ingredients,
  inventoryMovements,
  stockCountItems,
  stockCounts,
} from '@/lib/db/schema';
import type { StockCount, StockCountItem } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import {
  buildMovementKey,
  recordMovements,
  type RecordMovementInput,
} from '@/lib/data/inventory';
import { ensureDefaultArea, getAreaById } from '@/lib/data/storage-areas';
import { countAdjustment } from '@/lib/calculations/inventory-areas';

/**
 * Inventory depth — transfers + physical counts (Sprint 12c). Org-scoped (RULE #1),
 * runs inside the caller's `withOrg` transaction (RLS active). Area structure lives in
 * lib/data/storage-areas.ts; THIS module changes per-area BALANCES, and does so ONLY by
 * posting F1 movements (transfers + count adjustments) — never by editing the ledger.
 *
 * The balance invariant (review #7) holds by construction:
 *   ingredients.stock_quantity == Σ delta of ALL movements (every area incl. NULL)
 *   balance(area)              =  Σ delta of movements in that area
 *   Σ balances                 =  stock_quantity
 * The default area also owns the legacy NULL bucket (`= defaultId OR IS NULL`).
 *
 * Concurrency is serialized by the per-ingredient `FOR UPDATE` lock (F1); per-area
 * balances are ALWAYS read inside the tx AFTER the lock, never cached from a preview.
 * MONEY-FREE end-to-end.
 */

/** A resolved write target: the concrete area id + whether it owns the NULL bucket. */
export type ResolvedArea = { id: string; isDefault: boolean };

/**
 * Resolve an area id for a WRITE. `null` is the legacy/default alias → the org's
 * concrete default area (seeded if missing). A concrete id must resolve to an ACTIVE
 * same-org area (else `null` → the caller maps to NOT_FOUND). The default area's
 * `isDefault` flag drives the `= id OR IS NULL` balance rule.
 */
export async function resolveAreaForWrite(
  db: TenantClient,
  organizationId: string,
  areaId: string | null,
): Promise<ResolvedArea | null> {
  if (areaId === null) {
    const def = await ensureDefaultArea(db, organizationId);
    return { id: def.id, isDefault: true };
  }
  const area = await getAreaById(db, organizationId, areaId);
  if (!area) return null;
  return { id: area.id, isDefault: area.isDefault };
}

/** SQL predicate selecting an area's movements (default also owns the NULL bucket). */
function areaPredicate(area: ResolvedArea) {
  return area.isDefault
    ? sql`(${inventoryMovements.storageAreaId} = ${area.id} or ${inventoryMovements.storageAreaId} is null)`
    : eq(inventoryMovements.storageAreaId, area.id);
}

/** Live per-area balance of ONE ingredient (read under the F1 ingredient lock). */
export async function areaBalanceOf(
  db: TenantClient,
  organizationId: string,
  area: ResolvedArea,
  ingredientId: string,
): Promise<number> {
  const [row] = await db
    .select({ sum: sql<string>`coalesce(sum(${inventoryMovements.deltaCanonical}), 0)` })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.organizationId, organizationId),
        eq(inventoryMovements.ingredientId, ingredientId),
        areaPredicate(area),
      ),
    );
  return Number(row?.sum ?? 0);
}

/** Per-area balances for EVERY ingredient with movements in the area (UI + count pre-fill). */
export async function areaBalances(
  db: TenantClient,
  organizationId: string,
  area: ResolvedArea,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      ingredientId: inventoryMovements.ingredientId,
      sum: sql<string>`coalesce(sum(${inventoryMovements.deltaCanonical}), 0)`,
    })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.organizationId, organizationId),
        areaPredicate(area),
      ),
    )
    .groupBy(inventoryMovements.ingredientId);
  return new Map(rows.map((r) => [r.ingredientId, Number(r.sum)]));
}

/** Lock the ACTIVE same-org ingredient FOR UPDATE (consistent floor read + post). */
async function lockIngredient(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: ingredients.id })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, ingredientId),
        isNull(ingredients.deletedAt),
      ),
    )
    .for('update');
  return Boolean(row);
}

// ── Transfers ─────────────────────────────────────────────────────────────────

export type TransferStockArgs = {
  ingredientId: string;
  areaFromId: string | null;
  areaToId: string | null;
  qty: number;
  /** Caller-supplied UUID → deterministic F1 replay key. */
  clientTransferId: string;
};

export type TransferStockOutcome =
  | {
      status: 'ok';
      deduped: boolean;
      areaFrom: ResolvedArea;
      areaTo: ResolvedArea;
      /** Post-transfer balances of the moved ingredient in each area. */
      balanceFrom: number;
      balanceTo: number;
    }
  | { status: 'area_not_found' }
  | { status: 'same_area' }
  | { status: 'ingredient_not_found' }
  | { status: 'insufficient_stock' }
  | { status: 'idempotency_conflict' };

/**
 * Move `qty` of one ingredient from area A to area B as a balanced pair of F1 movements
 * that nets ZERO at the ingredient level (so `stock_quantity` is unchanged; only the
 * area split moves). Order: lock the ingredient → (unless this is a replay) per-area
 * floor on the SOURCE → `recordMovements([IN, OUT])`.
 *
 * The IN leg is posted BEFORE the OUT leg so a net-zero transfer never trips
 * `recordMovement`'s ORG-total floor when the default/NULL bucket is negative from
 * earlier area-agnostic consumption (review #1). The source-area floor is the real
 * guard. `recordMovements` THROWS `MovementError` on any F1 failure → the whole withOrg
 * rolls back (no partial transfer); the caller maps it.
 *
 * Idempotent: a replay with the same `clientTransferId` dedups (no second movement); a
 * same-key/different-payload replay surfaces `idempotency_conflict` (F1 full-payload
 * comparison incl. `storage_area_id`).
 */
export async function transferStock(
  db: TenantClient,
  organizationId: string,
  args: TransferStockArgs,
): Promise<TransferStockOutcome> {
  const areaFrom = await resolveAreaForWrite(db, organizationId, args.areaFromId);
  const areaTo = await resolveAreaForWrite(db, organizationId, args.areaToId);
  if (!areaFrom || !areaTo) return { status: 'area_not_found' };
  // Reject a self-transfer AFTER resolving null/default aliases (null vs defaultId).
  if (areaFrom.id === areaTo.id) return { status: 'same_area' };

  if (!(await lockIngredient(db, organizationId, args.ingredientId))) {
    return { status: 'ingredient_not_found' };
  }

  // Replay detection: if the OUT leg's key already exists, this transfer was applied —
  // skip the floor (the current source balance already reflects the prior move).
  const outKey = buildMovementKey('transfer', args.clientTransferId, 'out', args.ingredientId);
  const [existingOut] = await db
    .select({ id: inventoryMovements.id })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.organizationId, organizationId),
        eq(inventoryMovements.idempotencyKey, outKey),
      ),
    )
    .limit(1);
  const isReplay = Boolean(existingOut);

  if (!isReplay) {
    const balanceFrom = await areaBalanceOf(db, organizationId, areaFrom, args.ingredientId);
    if (args.qty > balanceFrom) return { status: 'insufficient_stock' };
  }

  // IN first, then OUT (both same ingredient → one lock; stable order preserved).
  const movements: RecordMovementInput[] = [
    {
      ingredientId: args.ingredientId,
      deltaCanonical: args.qty,
      source: { type: 'transfer', id: args.clientTransferId, lineId: 'in' },
      idempotencyKey: buildMovementKey('transfer', args.clientTransferId, 'in', args.ingredientId),
      storageAreaId: areaTo.id,
    },
    {
      ingredientId: args.ingredientId,
      deltaCanonical: -args.qty,
      source: { type: 'transfer', id: args.clientTransferId, lineId: 'out' },
      idempotencyKey: outKey,
      storageAreaId: areaFrom.id,
    },
  ];
  await recordMovements(db, organizationId, movements);

  const [balanceFrom, balanceTo] = await Promise.all([
    areaBalanceOf(db, organizationId, areaFrom, args.ingredientId),
    areaBalanceOf(db, organizationId, areaTo, args.ingredientId),
  ]);

  return {
    status: 'ok',
    deduped: isReplay,
    areaFrom,
    areaTo,
    balanceFrom,
    balanceTo,
  };
}

// ── Physical counts ─────────────────────────────────────────────────────────────

export type CreateStockCountArgs = {
  storageAreaId: string | null;
  note: string | null;
  createdBy: string | null;
};

export type CreateStockCountOutcome =
  | { status: 'ok'; count: StockCount }
  | { status: 'area_not_found' };

/** Start a DRAFT count for an area (the area id is resolved to a concrete value). */
export async function createStockCount(
  db: TenantClient,
  organizationId: string,
  args: CreateStockCountArgs,
): Promise<CreateStockCountOutcome> {
  const area = await resolveAreaForWrite(db, organizationId, args.storageAreaId);
  if (!area) return { status: 'area_not_found' };

  const [count] = await db
    .insert(stockCounts)
    .values({
      organizationId,
      storageAreaId: area.id,
      status: 'draft',
      note: args.note,
      createdBy: args.createdBy,
    })
    .returning();
  if (!count) throw new Error('Failed to create stock count.');
  return { status: 'ok', count };
}

export type StockCountDetail = {
  count: StockCount;
  items: StockCountItem[];
};

/** One count with its line items, or null. */
export async function getStockCountWithItems(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<StockCountDetail | null> {
  const [count] = await db
    .select()
    .from(stockCounts)
    .where(and(eq(stockCounts.organizationId, organizationId), eq(stockCounts.id, id)))
    .limit(1);
  if (!count) return null;
  const items = await db
    .select()
    .from(stockCountItems)
    .where(
      and(
        eq(stockCountItems.organizationId, organizationId),
        eq(stockCountItems.stockCountId, id),
      ),
    )
    .orderBy(asc(stockCountItems.createdAt), asc(stockCountItems.id));
  return { count, items };
}

/** Counts newest-first for the list view. */
export async function listStockCounts(
  db: TenantClient,
  organizationId: string,
): Promise<StockCount[]> {
  return db
    .select()
    .from(stockCounts)
    .where(eq(stockCounts.organizationId, organizationId))
    .orderBy(sql`${stockCounts.createdAt} desc`);
}

type StockCountLock =
  | { status: 'ok'; row: StockCount }
  | { status: 'not_found' }
  | { status: 'stale' }
  | { status: 'not_editable' };

/** Lock a DRAFT count FOR UPDATE + optimistic concurrency. Committed → not_editable. */
async function lockDraftCount(
  db: TenantClient,
  organizationId: string,
  id: string,
  expectedUpdatedAt: Date,
): Promise<StockCountLock> {
  const [row] = await db
    .select()
    .from(stockCounts)
    .where(and(eq(stockCounts.organizationId, organizationId), eq(stockCounts.id, id)))
    .for('update');
  if (!row) return { status: 'not_found' };
  if (row.status !== 'draft') return { status: 'not_editable' };
  if (row.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return { status: 'stale' };
  return { status: 'ok', row };
}

export type UpdateStockCountArgs = {
  note: string | null;
  items: { ingredientId: string; countedCanonical: number }[];
};

export type UpdateStockCountOutcome =
  | { status: 'ok'; count: StockCount }
  | { status: 'not_found' }
  | { status: 'stale' }
  | { status: 'not_editable' };

/** Replace a draft count's note + line set (optimistic-locked on the count token). */
export async function updateStockCount(
  db: TenantClient,
  organizationId: string,
  id: string,
  expectedUpdatedAt: Date,
  args: UpdateStockCountArgs,
): Promise<UpdateStockCountOutcome> {
  const lock = await lockDraftCount(db, organizationId, id, expectedUpdatedAt);
  if (lock.status !== 'ok') return { status: lock.status };

  await db
    .delete(stockCountItems)
    .where(
      and(
        eq(stockCountItems.organizationId, organizationId),
        eq(stockCountItems.stockCountId, id),
      ),
    );

  // Collapse duplicate ingredient ids (last wins) so the unique index never trips.
  const byIngredient = new Map<string, number>();
  for (const item of args.items) byIngredient.set(item.ingredientId, item.countedCanonical);
  if (byIngredient.size > 0) {
    await db.insert(stockCountItems).values(
      [...byIngredient.entries()].map(([ingredientId, counted]) => ({
        organizationId,
        stockCountId: id,
        ingredientId,
        countedCanonical: counted.toString(),
      })),
    );
  }

  const [count] = await db
    .update(stockCounts)
    .set({ note: args.note, updatedAt: new Date() })
    .where(and(eq(stockCounts.organizationId, organizationId), eq(stockCounts.id, id)))
    .returning();
  if (!count) return { status: 'not_found' };
  return { status: 'ok', count };
}

export type DeleteStockCountOutcome =
  | { status: 'ok' }
  | { status: 'not_found' }
  | { status: 'stale' }
  | { status: 'not_editable' };

/** Hard-delete a DRAFT count; its items cascade. Committed counts are permanent. */
export async function deleteStockCount(
  db: TenantClient,
  organizationId: string,
  id: string,
  expectedUpdatedAt: Date,
): Promise<DeleteStockCountOutcome> {
  const lock = await lockDraftCount(db, organizationId, id, expectedUpdatedAt);
  if (lock.status !== 'ok') return { status: lock.status };

  await db
    .delete(stockCounts)
    .where(and(eq(stockCounts.organizationId, organizationId), eq(stockCounts.id, id)));
  return { status: 'ok' };
}

export type CommitStockCountOutcome =
  | {
      status: 'ok';
      count: StockCount;
      alreadyCommitted: boolean;
      lineCount: number;
      movementCount: number;
    }
  | { status: 'not_found' }
  | { status: 'stale' }
  | { status: 'incomplete' };

/**
 * Commit a DRAFT count (Sprint 12c). Under the count lock + the per-ingredient locks:
 * for each line compute `delta = counted − liveAreaBalance` AT COMMIT (never a value
 * snapshotted at entry — so a sale between entry and commit isn't double-applied),
 * post one F1 `adjustment` movement per NON-zero delta via `recordMovements`
 * (throw-to-rollback), record `system_canonical` + `movement_id` back onto each item,
 * then flip the count to `committed`.
 *
 *  - an already-committed count is an ok/no-op retry (status guard, before the stale
 *    check) — F1 idempotency keys are the backstop;
 *  - a missing/trashed counted ingredient → `incomplete` (no movement written);
 *  - a shortfall makes `recordMovements` THROW → the action catches it after rollback.
 */
export async function commitStockCount(
  db: TenantClient,
  organizationId: string,
  id: string,
  expectedUpdatedAt: Date,
): Promise<CommitStockCountOutcome> {
  // Lock the count row (any state) for an idempotent already-committed retry.
  const [row] = await db
    .select()
    .from(stockCounts)
    .where(and(eq(stockCounts.organizationId, organizationId), eq(stockCounts.id, id)))
    .for('update');
  if (!row) return { status: 'not_found' };
  if (row.status === 'committed') {
    return { status: 'ok', count: row, alreadyCommitted: true, lineCount: 0, movementCount: 0 };
  }
  if (row.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return { status: 'stale' };

  const area = await resolveAreaForWrite(db, organizationId, row.storageAreaId);
  if (!area) return { status: 'incomplete' };

  const items = await db
    .select()
    .from(stockCountItems)
    .where(
      and(
        eq(stockCountItems.organizationId, organizationId),
        eq(stockCountItems.stockCountId, id),
      ),
    )
    .orderBy(asc(stockCountItems.id));

  // Lock every counted ingredient id-asc (the order recordMovements uses) — a racing
  // trash serializes; a missing/trashed counted ingredient aborts before any write.
  const ingredientIds = [...new Set(items.map((i) => i.ingredientId))].sort();
  if (ingredientIds.length > 0) {
    const locked = await db
      .select({ id: ingredients.id })
      .from(ingredients)
      .where(
        and(
          eq(ingredients.organizationId, organizationId),
          inArray(ingredients.id, ingredientIds),
          isNull(ingredients.deletedAt),
        ),
      )
      .orderBy(asc(ingredients.id))
      .for('update');
    if (locked.length !== ingredientIds.length) return { status: 'incomplete' };
  }

  // Compute the live system balance + adjustment delta per line, under the locks.
  const movements: RecordMovementInput[] = [];
  const systemByItem = new Map<string, number>();
  for (const item of items) {
    const system = await areaBalanceOf(db, organizationId, area, item.ingredientId);
    systemByItem.set(item.id, system);
    const delta = countAdjustment(Number(item.countedCanonical), system);
    if (delta !== 0) {
      movements.push({
        ingredientId: item.ingredientId,
        deltaCanonical: delta,
        source: { type: 'adjustment', id, lineId: item.id },
        idempotencyKey: buildMovementKey('adjustment', id, item.id, item.ingredientId),
        storageAreaId: area.id,
        note: 'stock_count',
      });
    }
  }

  if (movements.length > 0) {
    await recordMovements(db, organizationId, movements);
  }

  // Map each posted adjustment back to its line via source_line_id (= count item id).
  const posted = await db
    .select({ id: inventoryMovements.id, sourceLineId: inventoryMovements.sourceLineId })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.organizationId, organizationId),
        eq(inventoryMovements.sourceType, 'adjustment'),
        eq(inventoryMovements.sourceId, id),
      ),
    );
  const movementByItem = new Map(posted.map((m) => [m.sourceLineId ?? '', m.id]));

  // Record the system snapshot + movement id on every line (NULL movement when delta 0).
  for (const item of items) {
    await db
      .update(stockCountItems)
      .set({
        systemCanonical: (systemByItem.get(item.id) ?? 0).toString(),
        movementId: movementByItem.get(item.id) ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(stockCountItems.organizationId, organizationId),
          eq(stockCountItems.id, item.id),
        ),
      );
  }

  const [committed] = await db
    .update(stockCounts)
    .set({ status: 'committed', committedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(stockCounts.organizationId, organizationId), eq(stockCounts.id, id)))
    .returning();
  if (!committed) return { status: 'not_found' };

  return {
    status: 'ok',
    count: committed,
    alreadyCommitted: false,
    lineCount: items.length,
    movementCount: movements.length,
  };
}
