import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  ingredients,
  inventoryMovements,
  purchaseOrders,
  purchaseOrderItems,
  receiptItems,
  receipts,
} from '@/lib/db/schema';
import type { Receipt, ReceiptItem } from '@/lib/db/schema';
import type { Dimension } from '@/lib/units';
import type { TenantClient } from '@/lib/db/tenant';
import {
  buildMovementKey,
  recordMovements,
  type RecordMovementInput,
} from '@/lib/data/inventory';
import {
  recordDerivedPriceObservation,
  recomputePendingAfterVoid,
} from '@/lib/data/ingredient-pricing';
import { purchaseOrderLineTotalCents } from '@/lib/calculations/purchaseOrder';
import {
  PO_INT4_MAX,
  receiptPayloadHash,
  type PostReceiptInput,
} from '@/lib/validation/receipts';

/**
 * Goods receipts (Sprint 8b). Always org-scoped (RULE #1); RLS is the second layer.
 * Receipts are financial/inventory data — every caller is behind the manager-only
 * RBAC gate.
 *
 * Posting a receipt against a `sent`/`partially_received` PO books idempotent IN
 * stock movements through the F1 ledger and raises the F2 pending cost; it never
 * touches `ingredients.price_cents`. A CORRECTION never edits a movement — it `void`s
 * the receipt and posts F1 reversals (the receipt row is retained for history). The
 * PO rolls `sent → partially_received → received`; `received` is terminal for new
 * receipts (the only way back is a void). All mutators must run inside `withOrg`.
 */

export type ReceiptWithItems = { receipt: Receipt; items: ReceiptItem[] };

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Per-ordered-line received totals over POSTED receipts only (Sprint 8b D2). Voided
 * receipts are excluded, so this is the authoritative "how much has arrived" rollup.
 */
export async function receivedRollup(
  db: TenantClient,
  organizationId: string,
  purchaseOrderId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      poItemId: receiptItems.purchaseOrderItemId,
      total: sql<string>`sum(${receiptItems.receivedQuantity})`,
    })
    .from(receiptItems)
    .innerJoin(
      receipts,
      and(
        eq(receipts.organizationId, receiptItems.organizationId),
        eq(receipts.id, receiptItems.receiptId),
      ),
    )
    .where(
      and(
        eq(receiptItems.organizationId, organizationId),
        eq(receipts.purchaseOrderId, purchaseOrderId),
        eq(receipts.status, 'posted'),
      ),
    )
    .groupBy(receiptItems.purchaseOrderItemId);

  const map = new Map<string, number>();
  for (const r of rows) map.set(r.poItemId, Number(r.total));
  return map;
}

/** Receipts for a PO, newest first, each with its lines. */
export async function listReceiptsForPurchaseOrder(
  db: TenantClient,
  organizationId: string,
  purchaseOrderId: string,
): Promise<ReceiptWithItems[]> {
  const receiptRows = await db
    .select()
    .from(receipts)
    .where(
      and(
        eq(receipts.organizationId, organizationId),
        eq(receipts.purchaseOrderId, purchaseOrderId),
      ),
    )
    .orderBy(desc(receipts.createdAt));
  if (receiptRows.length === 0) return [];

  const itemRows = await db
    .select()
    .from(receiptItems)
    .where(
      and(
        eq(receiptItems.organizationId, organizationId),
        inArray(
          receiptItems.receiptId,
          receiptRows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(asc(receiptItems.sortOrder));

  const byReceipt = new Map<string, ReceiptItem[]>();
  for (const item of itemRows) {
    const list = byReceipt.get(item.receiptId) ?? [];
    list.push(item);
    byReceipt.set(item.receiptId, list);
  }
  return receiptRows.map((receipt) => ({
    receipt,
    items: byReceipt.get(receipt.id) ?? [],
  }));
}

export async function getReceiptWithItems(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<ReceiptWithItems | null> {
  const [receipt] = await db
    .select()
    .from(receipts)
    .where(and(eq(receipts.organizationId, organizationId), eq(receipts.id, id)))
    .limit(1);
  if (!receipt) return null;
  const items = await db
    .select()
    .from(receiptItems)
    .where(
      and(
        eq(receiptItems.organizationId, organizationId),
        eq(receiptItems.receiptId, id),
      ),
    )
    .orderBy(asc(receiptItems.sortOrder));
  return { receipt, items };
}

/* -------------------------------------------------------------------------- */
/* PO status recompute (shared by post + void)                                */
/* -------------------------------------------------------------------------- */

/**
 * Recompute and persist a PO's status from its posted receipts (Sprint 8b). Called
 * after a post or a void — never for draft/cancelled POs.
 *  - no posted receipt  → `sent` (clears received_at + any short-close reason);
 *  - all lines fully received → `received` (stamps received_at);
 *  - otherwise → `partially_received` (clears received_at + reopens a short-close, B6).
 *
 * `closePurchaseOrder` (short-close) sets `received` + `closed_reason` directly and
 * does NOT go through here, so an explicit short-close is preserved until a void
 * reopens the PO.
 */
async function recomputePoStatus(
  db: TenantClient,
  organizationId: string,
  purchaseOrderId: string,
  now: Date,
): Promise<void> {
  const orderedLines = await db
    .select({ id: purchaseOrderItems.id, quantity: purchaseOrderItems.quantity })
    .from(purchaseOrderItems)
    .where(
      and(
        eq(purchaseOrderItems.organizationId, organizationId),
        eq(purchaseOrderItems.purchaseOrderId, purchaseOrderId),
      ),
    );

  const [hasPosted] = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(
      and(
        eq(receipts.organizationId, organizationId),
        eq(receipts.purchaseOrderId, purchaseOrderId),
        eq(receipts.status, 'posted'),
      ),
    )
    .limit(1);

  if (!hasPosted) {
    await db
      .update(purchaseOrders)
      .set({ status: 'sent', receivedAt: null, closedReason: null })
      .where(
        and(
          eq(purchaseOrders.organizationId, organizationId),
          eq(purchaseOrders.id, purchaseOrderId),
        ),
      );
    return;
  }

  const rollup = await receivedRollup(db, organizationId, purchaseOrderId);
  const allReceived =
    orderedLines.length > 0 &&
    orderedLines.every(
      (line) => (rollup.get(line.id) ?? 0) >= Number(line.quantity),
    );

  if (allReceived) {
    // Stamp received_at only if not already set (keep the first completion time).
    await db
      .update(purchaseOrders)
      .set({ status: 'received', receivedAt: sql`coalesce(${purchaseOrders.receivedAt}, ${now})` })
      .where(
        and(
          eq(purchaseOrders.organizationId, organizationId),
          eq(purchaseOrders.id, purchaseOrderId),
        ),
      );
  } else {
    // Reopen: clear received_at + any short-close reason (B6).
    await db
      .update(purchaseOrders)
      .set({ status: 'partially_received', receivedAt: null, closedReason: null })
      .where(
        and(
          eq(purchaseOrders.organizationId, organizationId),
          eq(purchaseOrders.id, purchaseOrderId),
        ),
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Post a receipt                                                             */
/* -------------------------------------------------------------------------- */

export type PostReceiptResult =
  | { status: 'ok'; receipt: Receipt; deduped: boolean }
  | { status: 'not_receivable' }
  | { status: 'line_ingredient_missing' }
  | { status: 'invalid' }
  | { status: 'conflict' };

/**
 * Books a delivery against a `sent`/`partially_received` PO. The algorithm puts the
 * D6 idempotency check FIRST (B2) so a retry after the PO is already `received`
 * returns the existing receipt rather than `not_receivable`:
 *   0. dedup on (org, client_mutation_id): same payload → existing receipt, different
 *      payload → conflict;
 *   1. lock the PO; status must be sent/partially_received;
 *   2. resolve each line to its ordered PO line + live active ingredient (snapshot);
 *   3. insert the receipt + lines;
 *   4. F1 IN movements (recordMovements; THROWS on failure → whole withOrg rolls back);
 *   5. F2 observe per line (raise pending cost, never price_cents);
 *   6. recompute PO status.
 */
export async function postReceipt(
  db: TenantClient,
  organizationId: string,
  actorUserId: string | null,
  input: PostReceiptInput,
  now: Date = new Date(),
): Promise<PostReceiptResult> {
  const payloadHash = receiptPayloadHash(input);

  // 0. D6 dedup — BEFORE any status validation (B2).
  const [existing] = await db
    .select()
    .from(receipts)
    .where(
      and(
        eq(receipts.organizationId, organizationId),
        eq(receipts.clientMutationId, input.clientMutationId),
      ),
    )
    .limit(1);
  if (existing) {
    return existing.payloadHash === payloadHash
      ? { status: 'ok', receipt: existing, deduped: true }
      : { status: 'conflict' };
  }

  // 1. Lock the PO; only sent/partially_received can receive (received is terminal).
  const [po] = await db
    .select({ id: purchaseOrders.id, status: purchaseOrders.status })
    .from(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.organizationId, organizationId),
        eq(purchaseOrders.id, input.purchaseOrderId),
      ),
    )
    .for('update')
    .limit(1);
  if (!po || (po.status !== 'sent' && po.status !== 'partially_received')) {
    return { status: 'not_receivable' };
  }

  // 2. Resolve each receipt line to its ordered PO line (must belong to this PO) and
  // its live, active ingredient (for the snapshot + the movement).
  const poItemIds = input.items.map((it) => it.purchaseOrderItemId);
  const orderedLines = await db
    .select({
      id: purchaseOrderItems.id,
      ingredientId: purchaseOrderItems.ingredientId,
    })
    .from(purchaseOrderItems)
    .where(
      and(
        eq(purchaseOrderItems.organizationId, organizationId),
        eq(purchaseOrderItems.purchaseOrderId, input.purchaseOrderId),
        inArray(purchaseOrderItems.id, poItemIds),
      ),
    );
  const orderedById = new Map(orderedLines.map((l) => [l.id, l]));
  // Every requested line must map to an ordered line of THIS PO.
  if (orderedById.size !== new Set(poItemIds).size) {
    return { status: 'line_ingredient_missing' };
  }

  const ingredientIds = orderedLines
    .map((l) => l.ingredientId)
    .filter((v): v is string => v != null);
  if (ingredientIds.length !== orderedLines.length) {
    return { status: 'line_ingredient_missing' };
  }
  const ingredientRows = await db
    .select({
      id: ingredients.id,
      name: ingredients.name,
      dimension: ingredients.dimension,
    })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        inArray(ingredients.id, ingredientIds),
        isNull(ingredients.deletedAt),
      ),
    );
  const ingredientById = new Map(
    ingredientRows.map((r) => [r.id, { name: r.name, dimension: r.dimension }]),
  );
  if (ingredientById.size !== new Set(ingredientIds).size) {
    return { status: 'line_ingredient_missing' };
  }

  // Build the line rows + guard the int4 ceiling on each computed total.
  type Built = {
    purchaseOrderItemId: string;
    ingredientId: string;
    ingredientName: string;
    dimension: Dimension;
    receivedQuantity: number;
    receivedUnitCostCents: number;
    lineTotalCents: number;
  };
  const built: Built[] = [];
  for (const it of input.items) {
    const ordered = orderedById.get(it.purchaseOrderItemId)!;
    const ing = ingredientById.get(ordered.ingredientId as string)!;
    const lineTotalCents = purchaseOrderLineTotalCents({
      dimension: ing.dimension,
      unitCostCents: it.receivedUnitCostCents,
      quantity: it.receivedQuantity,
    });
    if (lineTotalCents > PO_INT4_MAX) return { status: 'invalid' };
    built.push({
      purchaseOrderItemId: it.purchaseOrderItemId,
      ingredientId: ordered.ingredientId as string,
      ingredientName: ing.name,
      dimension: ing.dimension,
      receivedQuantity: it.receivedQuantity,
      receivedUnitCostCents: it.receivedUnitCostCents,
      lineTotalCents,
    });
  }

  // 3. Insert the receipt header + lines.
  const [receipt] = await db
    .insert(receipts)
    .values({
      organizationId,
      purchaseOrderId: input.purchaseOrderId,
      receivedDate: input.receivedDate,
      notes: input.notes,
      status: 'posted',
      actorUserId,
      clientMutationId: input.clientMutationId,
      payloadHash,
    })
    .returning();
  if (!receipt) throw new Error('Failed to create receipt.');

  const insertedItems = await db
    .insert(receiptItems)
    .values(
      built.map((b, index) => ({
        organizationId,
        receiptId: receipt.id,
        purchaseOrderId: input.purchaseOrderId,
        purchaseOrderItemId: b.purchaseOrderItemId,
        ingredientId: b.ingredientId,
        ingredientName: b.ingredientName,
        dimension: b.dimension,
        receivedQuantity: String(b.receivedQuantity),
        receivedUnitCostCents: b.receivedUnitCostCents,
        lineTotalCents: b.lineTotalCents,
        sortOrder: index,
      })),
    )
    .returning({
      id: receiptItems.id,
      ingredientId: receiptItems.ingredientId,
      receivedQuantity: receiptItems.receivedQuantity,
    });

  // 4. F1 IN movements (one per line). recordMovements locks ingredients id-asc and
  // THROWS on any failure so the whole withOrg rolls back (no half-applied receipt).
  const movements: RecordMovementInput[] = insertedItems.map((ri) => ({
    ingredientId: ri.ingredientId,
    deltaCanonical: Number(ri.receivedQuantity),
    source: { type: 'purchase_receipt', id: receipt.id, lineId: ri.id },
    idempotencyKey: buildMovementKey(
      'purchase_receipt',
      receipt.id,
      ri.id,
      ri.ingredientId,
    ),
  }));
  await recordMovements(db, organizationId, movements);

  // 5. F2 observe per line: raise the pending cost, never price_cents (D3).
  for (const ri of insertedItems) {
    const item = built.find((b) => b.ingredientId === ri.ingredientId);
    await recordDerivedPriceObservation(db, organizationId, {
      ingredientId: ri.ingredientId,
      derivedPriceCents: item!.receivedUnitCostCents,
      sourceReceiptItemId: ri.id,
      actorUserId,
    });
  }

  // 6. Roll the PO status forward.
  await recomputePoStatus(db, organizationId, input.purchaseOrderId, now);

  return { status: 'ok', receipt, deduped: false };
}

/* -------------------------------------------------------------------------- */
/* Void a receipt (correction)                                               */
/* -------------------------------------------------------------------------- */

export type VoidReceiptResult =
  | { status: 'ok'; alreadyVoided: boolean }
  | { status: 'not_found' };

/**
 * Voids a posted receipt (Sprint 8b correction). Posts an F1 reversal for every IN
 * movement (never edits a movement), flips the receipt to `voided`, recomputes the
 * F2 pending cost for each affected ingredient (B3), and recomputes the PO status —
 * reopening + clearing a short-close if it drops below fully received (B6).
 *
 * If the goods were already consumed, the reversal would drive stock below zero;
 * `recordMovements` THROWS `MovementError('insufficient_stock')` and the whole
 * `withOrg` rolls back, so the void is blocked (B4) — the action maps the throw to
 * `INSUFFICIENT_STOCK`. Idempotent: voiding an already-voided receipt is a no-op.
 */
export async function voidReceipt(
  db: TenantClient,
  organizationId: string,
  receiptId: string,
  now: Date = new Date(),
): Promise<VoidReceiptResult> {
  const [receipt] = await db
    .select({
      id: receipts.id,
      status: receipts.status,
      purchaseOrderId: receipts.purchaseOrderId,
    })
    .from(receipts)
    .where(and(eq(receipts.organizationId, organizationId), eq(receipts.id, receiptId)))
    .for('update')
    .limit(1);
  if (!receipt) return { status: 'not_found' };
  if (receipt.status === 'voided') return { status: 'ok', alreadyVoided: true };

  // Find this receipt's IN movements (traceability index) — the rows to reverse.
  const inMovements = await db
    .select({
      id: inventoryMovements.id,
      ingredientId: inventoryMovements.ingredientId,
      deltaCanonical: inventoryMovements.deltaCanonical,
    })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.organizationId, organizationId),
        eq(inventoryMovements.sourceType, 'purchase_receipt'),
        eq(inventoryMovements.sourceId, receiptId),
      ),
    );

  // Post the opposite reversals (id-asc lock order via recordMovements). Throws to
  // roll back if any would breach the stock floor (B4).
  const reversals: RecordMovementInput[] = inMovements.map((m) => ({
    ingredientId: m.ingredientId,
    deltaCanonical: -Number(m.deltaCanonical),
    source: { type: 'reversal', id: receiptId, lineId: null },
    reversalOf: m.id,
    idempotencyKey: buildMovementKey('reversal', m.id, null, m.ingredientId),
  }));
  if (reversals.length > 0) {
    await recordMovements(db, organizationId, reversals);
  }

  // Flip the receipt to voided.
  await db
    .update(receipts)
    .set({ status: 'voided', voidedAt: now })
    .where(and(eq(receipts.organizationId, organizationId), eq(receipts.id, receiptId)));

  // Recompute the F2 pending cost for each affected ingredient (B3).
  const affectedIngredientIds = [...new Set(inMovements.map((m) => m.ingredientId))];
  for (const ingredientId of affectedIngredientIds) {
    await recomputePendingAfterVoid(db, organizationId, ingredientId);
  }

  // Recompute the PO status (may reopen + clear a short-close).
  await recomputePoStatus(db, organizationId, receipt.purchaseOrderId, now);

  return { status: 'ok', alreadyVoided: false };
}

/* -------------------------------------------------------------------------- */
/* Short-close                                                               */
/* -------------------------------------------------------------------------- */

export type ClosePurchaseOrderResult =
  | { status: 'ok' }
  | { status: 'not_found' }
  | { status: 'not_partially_received' };

/**
 * Short-close a `partially_received` PO (Sprint 8b D4): declares "no more coming",
 * stamps `received` + the mandatory reason, without any stock effect. Only valid from
 * `partially_received`; a void later reopens it (B6).
 */
export async function closePurchaseOrder(
  db: TenantClient,
  organizationId: string,
  purchaseOrderId: string,
  reason: string,
  now: Date = new Date(),
): Promise<ClosePurchaseOrderResult> {
  const [po] = await db
    .select({ status: purchaseOrders.status, receivedAt: purchaseOrders.receivedAt })
    .from(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.organizationId, organizationId),
        eq(purchaseOrders.id, purchaseOrderId),
      ),
    )
    .for('update')
    .limit(1);
  if (!po) return { status: 'not_found' };
  if (po.status !== 'partially_received') {
    return { status: 'not_partially_received' };
  }

  await db
    .update(purchaseOrders)
    .set({
      status: 'received',
      receivedAt: po.receivedAt ?? now,
      closedReason: reason,
    })
    .where(
      and(
        eq(purchaseOrders.organizationId, organizationId),
        eq(purchaseOrders.id, purchaseOrderId),
        eq(purchaseOrders.status, 'partially_received'),
      ),
    );
  return { status: 'ok' };
}
