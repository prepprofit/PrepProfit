import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { ingredients, inventoryMovements } from '@/lib/db/schema';
import type { Ingredient, InventoryMovement } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';

/**
 * Inventory access is ALWAYS scoped by `organizationId`. Stock lives on the
 * ingredient row; every change is also appended to the inventory_movements
 * ledger in the SAME transaction (callers wrap these in `withOrg`).
 */

/** Provenance of a movement: what kind of event produced it, and its document. */
export type MovementSourceType =
  | 'manual'
  | 'purchase_receipt'
  | 'production'
  | 'sale'
  | 'stock_count'
  | 'adjustment'
  | 'reversal'
  | 'transfer'
  | 'import'
  | 'seed';

export type MovementSource = {
  type: MovementSourceType;
  /** Source document id (order/production/sale/count); null for manual/seed. */
  id?: string | null;
  /** Specific source line; null for document-level aggregated consumption. */
  lineId?: string | null;
};

export type RecordMovementInput = {
  ingredientId: string;
  /** Signed canonical change: positive = stock in, negative = stock out. */
  deltaCanonical: number;
  note?: string | null;
  /** What produced this movement (provenance + traceability). */
  source: MovementSource;
  /**
   * DETERMINISTIC, caller-built dedup key (unique per org). A retry/double-submit
   * MUST resend the SAME key so the movement applies exactly once. See
   * `buildMovementKey` for the sourced form; manual uses `"manual:<clientUuid>"`.
   */
  idempotencyKey: string;
  /** Set ONLY when `source.type === 'reversal'`: the movement being undone. */
  reversalOf?: string | null;
  /**
   * Physical location this movement lands in (Sprint 12c). `null`/omitted = the legacy
   * default bucket (which the immutable default area also owns), so every existing
   * caller (sales/production/seed/manual) stays NULL and keeps reconciling. Part of the
   * IMMUTABLE idempotency payload — a same-key/different-area row is a real conflict.
   */
  storageAreaId?: string | null;
};

export type RecordMovementReason =
  | 'not_found'
  | 'insufficient_stock'
  | 'idempotency_conflict';

export type RecordMovementResult =
  // `deduped` = the key already recorded an identical movement; stock unchanged.
  | { ok: true; ingredient: Ingredient; deduped?: true }
  | { ok: false; reason: RecordMovementReason };

/**
 * Build the deterministic idempotency key for a SOURCED movement (one source line
 * can explode into many ingredient movements, so the key includes the ingredient
 * — review #2). `source_line_id` falls back to `'agg'` for document-level
 * aggregated consumption with no single line.
 */
export function buildMovementKey(
  sourceType: MovementSourceType,
  sourceId: string,
  sourceLineId: string | null | undefined,
  ingredientId: string,
): string {
  return `${sourceType}:${sourceId}:${sourceLineId ?? 'agg'}:${ingredientId}`;
}

/**
 * Thrown by `recordMovements` (batch) when any movement fails, so the surrounding
 * `withOrg` transaction ROLLS BACK — `runInOrg` commits on return and rolls back
 * only on throw, so a returned `{ok:false}` mid-batch would COMMIT a partial
 * consumption. Batch consumers map this to a stable ActionErrorCode.
 */
export class MovementError extends Error {
  constructor(public readonly reason: RecordMovementReason) {
    super(`recordMovement failed: ${reason}`);
    this.name = 'MovementError';
  }
}

/** Whether an existing ledger row's CORE fields match the requested payload. */
function sameCore(row: InventoryMovement, input: RecordMovementInput): boolean {
  return (
    row.ingredientId === input.ingredientId &&
    Number(row.deltaCanonical) === input.deltaCanonical &&
    row.sourceType === input.source.type &&
    (row.sourceId ?? null) === (input.source.id ?? null)
  );
}

/**
 * Whether the FULL immutable payload matches. Used by BOTH the dedup pre-check
 * (step 2) and the post-conflict revalidation (step 5) — `storage_area_id` is part of
 * the immutable payload (Sprint 12c), so a same-key/different-area row is a real
 * `idempotency_conflict`, never silently treated as `deduped`.
 */
function sameFullPayload(
  row: InventoryMovement,
  input: RecordMovementInput,
): boolean {
  return (
    sameCore(row, input) &&
    (row.sourceLineId ?? null) === (input.source.lineId ?? null) &&
    (row.reversalOf ?? null) === (input.reversalOf ?? null) &&
    (row.storageAreaId ?? null) === (input.storageAreaId ?? null)
  );
}

/**
 * Append a movement and update the running stock total atomically and
 * IDEMPOTENTLY. The ledger is AUTHORITATIVE: every entry is a real, fully-applied
 * movement, so a stock-out larger than what's on hand is REJECTED rather than
 * silently clamped (the delta and stock would stop reconciling).
 *
 * Order matters (Sprint F1): `runInOrg` commits on a normal return and rolls back
 * only on throw, so a returned `{ok:false}` AFTER a write would COMMIT an orphan.
 * Everything that can fail is therefore checked BEFORE any write — each early
 * return is a no-op commit:
 *   1. lock the active same-org ingredient FOR UPDATE (missing/trashed → not_found);
 *   2. dedup pre-check by (org, idempotency_key) — identical payload → deduped,
 *      different payload → idempotency_conflict;
 *   3. stock-floor check (would go negative → insufficient_stock);
 *   4. INSERT … ON CONFLICT (org, idempotency_key) DO NOTHING RETURNING;
 *   5. no row back (a concurrent tx won the per-ORG key while we held a per-
 *      INGREDIENT lock) → re-fetch the winner and revalidate the FULL payload:
 *      identical → deduped, otherwise idempotency_conflict — never touch stock;
 *   6. inserted → apply the stock delta and return the updated ingredient.
 */
export async function recordMovement(
  db: TenantClient,
  organizationId: string,
  input: RecordMovementInput,
): Promise<RecordMovementResult> {
  // 1. Lock the active ingredient row (consistent stock check + write).
  const [current] = await db
    .select()
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, input.ingredientId),
        isNull(ingredients.deletedAt),
      ),
    )
    .for('update')
    .limit(1);
  if (!current) return { ok: false, reason: 'not_found' };

  // 2. Dedup pre-check: a prior commit with this key. Nothing written yet → safe.
  const [existing] = await db
    .select()
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.organizationId, organizationId),
        eq(inventoryMovements.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) {
    return sameFullPayload(existing, input)
      ? { ok: true, ingredient: current, deduped: true }
      : { ok: false, reason: 'idempotency_conflict' };
  }

  // 3. Stock floor. Nothing written yet → safe to return.
  if (Number(current.stockQuantity) + input.deltaCanonical < 0) {
    return { ok: false, reason: 'insufficient_stock' };
  }

  // 4. Append the movement, racing other tx on the per-org key.
  const inserted = await db
    .insert(inventoryMovements)
    .values({
      organizationId,
      ingredientId: input.ingredientId,
      deltaCanonical: input.deltaCanonical.toString(),
      note: input.note ?? null,
      sourceType: input.source.type,
      sourceId: input.source.id ?? null,
      sourceLineId: input.source.lineId ?? null,
      reversalOf: input.reversalOf ?? null,
      idempotencyKey: input.idempotencyKey,
      storageAreaId: input.storageAreaId ?? null,
    })
    .onConflictDoNothing({
      target: [
        inventoryMovements.organizationId,
        inventoryMovements.idempotencyKey,
      ],
    })
    .returning({ id: inventoryMovements.id });

  // 5. Lost the key race: the lock is per-INGREDIENT but the key is per-ORG, so a
  //    concurrent tx may have claimed this key for a DIFFERENT ingredient. Fetch
  //    the winner and revalidate the FULL immutable payload — never touch stock.
  if (inserted.length === 0) {
    const [winner] = await db
      .select()
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.organizationId, organizationId),
          eq(inventoryMovements.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (winner && sameFullPayload(winner, input)) {
      return { ok: true, ingredient: current, deduped: true };
    }
    return { ok: false, reason: 'idempotency_conflict' };
  }

  // 6. Inserted → apply the delta to the running stock total.
  const [row] = await db
    .update(ingredients)
    .set({
      stockQuantity: sql`${ingredients.stockQuantity} + ${input.deltaCanonical.toString()}::numeric`,
    })
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, input.ingredientId),
        isNull(ingredients.deletedAt),
      ),
    )
    .returning();
  if (!row) return { ok: false, reason: 'not_found' };

  return { ok: true, ingredient: row };
}

/**
 * Consume/apply N movements in ONE transaction (production 11b / sale 12a). Locks
 * ingredients in a DETERMINISTIC id-asc order (anti-deadlock when batches share
 * ingredients) and THROWS `MovementError` on the first failure so the whole
 * `withOrg` rolls back — a per-call `{ok:false}` is NOT enough (earlier movements
 * would already be committed → partial consumption). Returns the updated
 * ingredients on success. Callers wrap this in `withOrg` and map the throw to a
 * stable code.
 */
export async function recordMovements(
  db: TenantClient,
  organizationId: string,
  inputs: RecordMovementInput[],
): Promise<Ingredient[]> {
  const ordered = [...inputs].sort((a, b) =>
    a.ingredientId < b.ingredientId ? -1 : a.ingredientId > b.ingredientId ? 1 : 0,
  );
  const results: Ingredient[] = [];
  for (const input of ordered) {
    const result = await recordMovement(db, organizationId, input);
    if (!result.ok) throw new MovementError(result.reason);
    results.push(result.ingredient);
  }
  return results;
}

export async function setLowStockThreshold(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
  thresholdCanonical: number | null,
): Promise<Ingredient | null> {
  const [row] = await db
    .update(ingredients)
    .set({
      lowStockThreshold:
        thresholdCanonical == null ? null : thresholdCanonical.toString(),
    })
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, ingredientId),
        isNull(ingredients.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

export async function listMovements(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
  limit = 20,
): Promise<InventoryMovement[]> {
  return db
    .select()
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.organizationId, organizationId),
        eq(inventoryMovements.ingredientId, ingredientId),
      ),
    )
    .orderBy(desc(inventoryMovements.createdAt))
    .limit(limit);
}
