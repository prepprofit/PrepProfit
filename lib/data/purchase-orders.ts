import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  ingredients,
  purchaseOrderItems,
  purchaseOrders,
  receipts,
  suppliers,
} from '@/lib/db/schema';
import type {
  PurchaseOrder,
  PurchaseOrderItem,
  PurchaseOrderStatus,
} from '@/lib/db/schema';
import type { Dimension } from '@/lib/units';
import type { TenantClient } from '@/lib/db/tenant';
import { allocatePoNumber, advancePoCounterAtLeast } from '@/lib/data/po-counters';
import { getOrgSettingsRow } from '@/lib/data/org-settings';
import { getSupplierById } from '@/lib/data/suppliers';
import { supplierSnapshot } from '@/lib/documents/snapshots';
import type { PurchaseOrderLiveContext } from '@/lib/documents/po-data';
import {
  purchaseOrderLineTotalCents,
  purchaseOrderTotals,
} from '@/lib/calculations/purchaseOrder';
import { PO_INT4_MAX, type PurchaseOrderDraftInput } from '@/lib/validation/purchase-orders';
import {
  cancelPendingOutbox,
  enqueueEmail,
} from '@/lib/data/email-outbox';

/**
 * Purchase orders (Sprint 8a). Always org-scoped (RULE #1); RLS is the second
 * layer. POs are financial data — every caller is behind the manager-only RBAC gate.
 *
 * Lifecycle: draft → sent / cancelled (cancel-only — a sent PO is immutable). The
 * number is allocated at DRAFT CREATION (F6, gap-tolerant). At draft→sent the live
 * supplier + each line's ingredient name/dimension are FROZEN under row locks (F3
 * snapshot, the `issueInvoice` precedent), the negotiated line cost is KEPT, and one
 * email-outbox row is enqueued. Money is integer cents.
 */

export type PurchaseOrderListItem = {
  id: string;
  number: number;
  status: PurchaseOrderStatus;
  currencyCode: string;
  /** Snapshot supplier name if sent/cancelled, else the live linked supplier (draft). */
  supplierName: string | null;
  totalCents: number;
  orderDate: string | null;
  createdAt: Date;
};

/** Active POs for the org, newest first, with a display supplier name. */
export async function listPurchaseOrders(
  db: TenantClient,
  organizationId: string,
): Promise<PurchaseOrderListItem[]> {
  const rows = await db
    .select({
      id: purchaseOrders.id,
      number: purchaseOrders.number,
      status: purchaseOrders.status,
      currencyCode: purchaseOrders.currencyCode,
      snapshotName: purchaseOrders.supplierName,
      liveName: suppliers.name,
      totalCents: purchaseOrders.totalCents,
      orderDate: purchaseOrders.orderDate,
      createdAt: purchaseOrders.createdAt,
    })
    .from(purchaseOrders)
    .leftJoin(
      suppliers,
      and(
        eq(purchaseOrders.supplierId, suppliers.id),
        eq(suppliers.organizationId, organizationId),
      ),
    )
    .where(eq(purchaseOrders.organizationId, organizationId))
    .orderBy(desc(purchaseOrders.createdAt));

  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    status: r.status,
    currencyCode: r.currencyCode,
    supplierName: r.snapshotName ?? r.liveName ?? null,
    totalCents: r.totalCents,
    orderDate: r.orderDate,
    createdAt: r.createdAt,
  }));
}

export type PurchaseOrderWithItems = {
  order: PurchaseOrder;
  items: PurchaseOrderItem[];
};

/**
 * Batched detail loader for the draft POs on the list page: two org-scoped queries
 * total (orders + their items) instead of N+1 (mirrors `listDraftInvoiceDetails`).
 */
export async function listDraftPurchaseOrderDetails(
  db: TenantClient,
  organizationId: string,
  draftIds: string[],
): Promise<PurchaseOrderWithItems[]> {
  if (draftIds.length === 0) return [];

  const orderRows = await db
    .select()
    .from(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.organizationId, organizationId),
        inArray(purchaseOrders.id, draftIds),
      ),
    );

  const itemRows = await db
    .select()
    .from(purchaseOrderItems)
    .where(
      and(
        eq(purchaseOrderItems.organizationId, organizationId),
        inArray(purchaseOrderItems.purchaseOrderId, draftIds),
      ),
    )
    .orderBy(asc(purchaseOrderItems.sortOrder));

  const itemsByOrder = new Map<string, PurchaseOrderItem[]>();
  for (const item of itemRows) {
    const list = itemsByOrder.get(item.purchaseOrderId) ?? [];
    list.push(item);
    itemsByOrder.set(item.purchaseOrderId, list);
  }

  return orderRows.map((order) => ({
    order,
    items: itemsByOrder.get(order.id) ?? [],
  }));
}

export async function getPurchaseOrderWithItems(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<PurchaseOrderWithItems | null> {
  const [order] = await db
    .select()
    .from(purchaseOrders)
    .where(
      and(eq(purchaseOrders.organizationId, organizationId), eq(purchaseOrders.id, id)),
    )
    .limit(1);
  if (!order) return null;

  const items = await db
    .select()
    .from(purchaseOrderItems)
    .where(
      and(
        eq(purchaseOrderItems.organizationId, organizationId),
        eq(purchaseOrderItems.purchaseOrderId, id),
      ),
    )
    .orderBy(asc(purchaseOrderItems.sortOrder));

  return { order, items };
}

/**
 * Live data the PO document needs to render a DRAFT (the snapshot is empty until
 * send). For a sent/cancelled PO the frozen columns are used, so this returns empty
 * context. Must run inside `withOrg`.
 */
export async function loadPurchaseOrderLiveContext(
  db: TenantClient,
  organizationId: string,
  detail: PurchaseOrderWithItems,
): Promise<PurchaseOrderLiveContext> {
  if (detail.order.status !== 'draft') {
    return { supplier: null, ingredientsById: new Map() };
  }
  const supplierRow = detail.order.supplierId
    ? await getSupplierById(db, organizationId, detail.order.supplierId)
    : null;
  const ids = detail.items
    .map((it) => it.ingredientId)
    .filter((v): v is string => v != null);
  const ingredientsById = await loadActiveIngredients(db, organizationId, ids, false);
  return {
    supplier: supplierRow
      ? {
          name: supplierRow.name,
          taxId: supplierRow.taxId,
          address: supplierRow.address,
          email: supplierRow.email,
          phone: supplierRow.phone,
        }
      : null,
    ingredientsById,
  };
}

/* -------------------------------------------------------------------------- */
/* Line computation                                                           */
/* -------------------------------------------------------------------------- */

type BuiltLine = {
  ingredientId: string;
  ingredientName: string;
  dimension: Dimension;
  quantity: number;
  unitCostCents: number;
  lineTotalCents: number;
};

/** Active (id → {name, dimension}) for the given ids, optionally row-locked (id-asc). */
async function loadActiveIngredients(
  db: TenantClient,
  organizationId: string,
  ids: string[],
  lock: boolean,
): Promise<Map<string, { name: string; dimension: Dimension }>> {
  const map = new Map<string, { name: string; dimension: Dimension }>();
  if (ids.length === 0) return map;
  const base = db
    .select({
      id: ingredients.id,
      name: ingredients.name,
      dimension: ingredients.dimension,
    })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        inArray(ingredients.id, ids),
        isNull(ingredients.deletedAt),
      ),
    )
    // Deterministic lock order (id-asc) prevents deadlocks between concurrent sends.
    .orderBy(asc(ingredients.id));
  const rows = lock ? await base.for('update') : await base;
  for (const r of rows) map.set(r.id, { name: r.name, dimension: r.dimension });
  return map;
}

type BuildLinesResult =
  | { ok: true; lines: BuiltLine[]; subtotalCents: number; totalCents: number }
  | { ok: false; reason: 'ingredient_missing' | 'overflow' };

/** Resolve dimensions/names, compute line + PO totals, and guard the int4 ceiling. */
function buildLines(
  items: PurchaseOrderDraftInput['items'],
  byId: Map<string, { name: string; dimension: Dimension }>,
): BuildLinesResult {
  const lines: BuiltLine[] = [];
  for (const it of items) {
    const ing = byId.get(it.ingredientId);
    if (!ing) return { ok: false, reason: 'ingredient_missing' };
    const lineTotalCents = purchaseOrderLineTotalCents({
      dimension: ing.dimension,
      unitCostCents: it.unitCostCents,
      quantity: it.quantity,
    });
    if (lineTotalCents > PO_INT4_MAX) return { ok: false, reason: 'overflow' };
    lines.push({
      ingredientId: it.ingredientId,
      ingredientName: ing.name,
      dimension: ing.dimension,
      quantity: it.quantity,
      unitCostCents: it.unitCostCents,
      lineTotalCents,
    });
  }
  const totals = purchaseOrderTotals(
    lines.map((l) => ({
      dimension: l.dimension,
      unitCostCents: l.unitCostCents,
      quantity: l.quantity,
    })),
  );
  if (totals.subtotalCents > PO_INT4_MAX || totals.totalCents > PO_INT4_MAX) {
    return { ok: false, reason: 'overflow' };
  }
  return { ok: true, lines, subtotalCents: totals.subtotalCents, totalCents: totals.totalCents };
}

/** Insert a PO's line rows (ordered). Snapshot fields are filled only at send. */
async function insertItems(
  db: TenantClient,
  organizationId: string,
  purchaseOrderId: string,
  lines: BuiltLine[],
): Promise<void> {
  if (lines.length === 0) return;
  await db.insert(purchaseOrderItems).values(
    lines.map((l, index) => ({
      organizationId,
      purchaseOrderId,
      ingredientId: l.ingredientId,
      quantity: String(l.quantity),
      unitCostCents: l.unitCostCents,
      lineTotalCents: l.lineTotalCents,
      sortOrder: index,
    })),
  );
}

/* -------------------------------------------------------------------------- */
/* Create / update draft                                                      */
/* -------------------------------------------------------------------------- */

export type CreateDraftResult =
  | { status: 'ok'; order: PurchaseOrder }
  | { status: 'invalid' };

/**
 * Creates a DRAFT PO with its lines; the number is allocated now (F6), the currency
 * is frozen from org settings, and totals are computed + stored so the list shows an
 * amount before send. A line referencing a missing/trashed ingredient, or an
 * overflowing total, returns `invalid` (the action maps it to INVALID_INPUT).
 */
export async function createDraftPurchaseOrder(
  db: TenantClient,
  organizationId: string,
  input: PurchaseOrderDraftInput,
): Promise<CreateDraftResult> {
  const ids = input.items.map((it) => it.ingredientId);
  const byId = await loadActiveIngredients(db, organizationId, ids, false);
  const built = buildLines(input.items, byId);
  if (!built.ok) return { status: 'invalid' };

  const settings = await getOrgSettingsRow(db, organizationId);
  const currencyCode = settings?.currency ?? 'EUR';
  const number = await allocatePoNumber(db, organizationId);

  const [order] = await db
    .insert(purchaseOrders)
    .values({
      organizationId,
      number,
      currencyCode,
      supplierId: input.supplierId,
      expectedDate: input.expectedDate,
      notes: input.notes,
      subtotalCents: built.subtotalCents,
      totalCents: built.totalCents,
    })
    .returning();
  if (!order) throw new Error('Failed to create purchase order.');

  await insertItems(db, organizationId, order.id, built.lines);
  return { status: 'ok', order };
}

export type UpdateDraftResult =
  | { status: 'ok'; order: PurchaseOrder }
  | { status: 'not_draft' }
  | { status: 'invalid' }
  | { status: 'number_taken' };

/**
 * Replaces a DRAFT PO's supplier, notes, expected date and lines, recomputing
 * totals. A manual `number` edit advances the counter so it is never reused, and a
 * collision returns `number_taken`. Returns `not_draft` if the PO is missing or not
 * a draft (sent/cancelled are immutable). Re-asserts `status='draft'` in the UPDATE.
 */
export async function updateDraftPurchaseOrder(
  db: TenantClient,
  organizationId: string,
  id: string,
  input: PurchaseOrderDraftInput,
): Promise<UpdateDraftResult> {
  const [existing] = await db
    .select({ status: purchaseOrders.status, number: purchaseOrders.number })
    .from(purchaseOrders)
    .where(
      and(eq(purchaseOrders.organizationId, organizationId), eq(purchaseOrders.id, id)),
    )
    .limit(1);
  if (!existing || existing.status !== 'draft') return { status: 'not_draft' };

  const ids = input.items.map((it) => it.ingredientId);
  const byId = await loadActiveIngredients(db, organizationId, ids, false);
  const built = buildLines(input.items, byId);
  if (!built.ok) return { status: 'invalid' };

  const nextNumber = input.number ?? existing.number;

  // Pre-check a manual number change against a collision in the same org. Catching
  // the unique violation after the fact would poison the surrounding transaction, so
  // we reject BEFORE the write; the try/catch below is only a concurrent-race backstop.
  if (input.number != null && input.number !== existing.number) {
    const [clash] = await db
      .select({ id: purchaseOrders.id })
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.organizationId, organizationId),
          eq(purchaseOrders.number, input.number),
        ),
      )
      .limit(1);
    if (clash && clash.id !== id) return { status: 'number_taken' };
  }

  try {
    const [order] = await db
      .update(purchaseOrders)
      .set({
        number: nextNumber,
        supplierId: input.supplierId,
        expectedDate: input.expectedDate,
        notes: input.notes,
        subtotalCents: built.subtotalCents,
        totalCents: built.totalCents,
      })
      .where(
        and(
          eq(purchaseOrders.organizationId, organizationId),
          eq(purchaseOrders.id, id),
          // Re-assert draft so a concurrent send/cancel can't be clobbered.
          eq(purchaseOrders.status, 'draft'),
        ),
      )
      .returning();
    if (!order) return { status: 'not_draft' };

    // Keep the counter ahead of a manual edit so it never re-issues this number.
    if (input.number != null && input.number !== existing.number) {
      await advancePoCounterAtLeast(db, organizationId, input.number);
    }

    await db
      .delete(purchaseOrderItems)
      .where(
        and(
          eq(purchaseOrderItems.organizationId, organizationId),
          eq(purchaseOrderItems.purchaseOrderId, id),
        ),
      );
    await insertItems(db, organizationId, id, built.lines);
    return { status: 'ok', order };
  } catch (err) {
    if (isUniqueViolation(err, 'purchase_orders_org_number_key')) {
      return { status: 'number_taken' };
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Send (snapshot transition)                                                 */
/* -------------------------------------------------------------------------- */

export type SendOutcome =
  | { status: 'ok'; order: PurchaseOrder; enqueuedEmail: boolean }
  | { status: 'not_draft' }
  | { status: 'no_supplier' }
  | { status: 'supplier_inactive' }
  | { status: 'empty' }
  | { status: 'line_ingredient_missing' };

/**
 * Sends a DRAFT PO: locks the PO, the supplier and every line ingredient (id-asc,
 * anti-deadlock), FREEZES the supplier + line snapshots and the totals, flips status
 * to `sent`, stamps the order date, and enqueues ONE outbox row (only if the
 * supplier has an email). The negotiated line `unit_cost_cents` is KEPT — only the
 * ingredient name/dimension freeze. Must run inside `withOrg`.
 */
export async function sendPurchaseOrder(
  db: TenantClient,
  organizationId: string,
  id: string,
  now: Date = new Date(),
): Promise<SendOutcome> {
  // Lock the PO row FIRST; a concurrent send blocks here, then re-reads it as 'sent'.
  const [locked] = await db
    .select({ status: purchaseOrders.status, supplierId: purchaseOrders.supplierId })
    .from(purchaseOrders)
    .where(
      and(eq(purchaseOrders.organizationId, organizationId), eq(purchaseOrders.id, id)),
    )
    .for('update')
    .limit(1);
  if (!locked || locked.status !== 'draft') return { status: 'not_draft' };
  if (!locked.supplierId) return { status: 'no_supplier' };

  const items = await db
    .select()
    .from(purchaseOrderItems)
    .where(
      and(
        eq(purchaseOrderItems.organizationId, organizationId),
        eq(purchaseOrderItems.purchaseOrderId, id),
      ),
    )
    .orderBy(asc(purchaseOrderItems.sortOrder));
  if (items.length === 0) return { status: 'empty' };

  // Lock the supplier and assert it is active.
  const [supplier] = await db
    .select()
    .from(suppliers)
    .where(
      and(
        eq(suppliers.organizationId, organizationId),
        eq(suppliers.id, locked.supplierId),
      ),
    )
    .for('update')
    .limit(1);
  if (!supplier) return { status: 'no_supplier' };
  if (!supplier.active) return { status: 'supplier_inactive' };

  // Lock every referenced ingredient (id-asc). Any line whose ingredient is gone
  // (link nulled) or trashed → explicit error, never a silent drop.
  const lineIngredientIds = items
    .map((it) => it.ingredientId)
    .filter((v): v is string => v != null);
  if (lineIngredientIds.length !== items.length) {
    return { status: 'line_ingredient_missing' };
  }
  const byId = await loadActiveIngredients(db, organizationId, lineIngredientIds, true);
  if (byId.size !== new Set(lineIngredientIds).size) {
    return { status: 'line_ingredient_missing' };
  }

  // Freeze each line: snapshot name/dimension, KEEP the negotiated unit cost, and
  // recompute the line total against the current dimension.
  let subtotalCents = 0;
  for (const item of items) {
    const ing = byId.get(item.ingredientId as string);
    if (!ing) return { status: 'line_ingredient_missing' };
    const lineTotalCents = purchaseOrderLineTotalCents({
      dimension: ing.dimension,
      unitCostCents: item.unitCostCents,
      quantity: Number(item.quantity),
    });
    subtotalCents += lineTotalCents;
    await db
      .update(purchaseOrderItems)
      .set({
        ingredientName: ing.name,
        dimension: ing.dimension,
        lineTotalCents,
      })
      .where(
        and(
          eq(purchaseOrderItems.organizationId, organizationId),
          eq(purchaseOrderItems.id, item.id),
        ),
      );
  }

  const snap = supplierSnapshot(supplier);
  const orderDate = now.toISOString().slice(0, 10);
  const [order] = await db
    .update(purchaseOrders)
    .set({
      status: 'sent',
      orderDate,
      supplierName: snap.supplierName,
      supplierEmail: snap.supplierEmail,
      supplierPhone: snap.supplierPhone,
      supplierAddress: snap.supplierAddress,
      supplierTaxId: snap.supplierTaxId,
      subtotalCents,
      totalCents: subtotalCents,
    })
    .where(
      and(
        eq(purchaseOrders.organizationId, organizationId),
        eq(purchaseOrders.id, id),
        eq(purchaseOrders.status, 'draft'),
      ),
    )
    .returning();
  if (!order) return { status: 'not_draft' };

  // Enqueue the send email only when the supplier has an address (the PO is still
  // 'sent' without one — it can be downloaded/printed and emailed manually).
  let enqueuedEmail = false;
  const to = snap.supplierEmail?.trim();
  if (to) {
    await enqueueEmail(db, organizationId, {
      documentType: 'purchase_order',
      documentId: id,
      toEmail: to,
      subject: null,
      dedupKey: `purchase_order:${id}:send`,
    });
    enqueuedEmail = true;
  }

  return { status: 'ok', order, enqueuedEmail };
}

/* -------------------------------------------------------------------------- */
/* Cancel / delete                                                            */
/* -------------------------------------------------------------------------- */

export type CancelOutcome =
  | { status: 'ok'; order: PurchaseOrder; cancelNoticeEnqueued: boolean }
  | { status: 'not_found' }
  | { status: 'has_receipts' };

/**
 * Cancels a draft or sent PO. Idempotent: cancelling an already-cancelled PO is a
 * no-op `ok`. When a SENT PO is cancelled, any un-sent outbox row is cancelled so
 * the worker skips it; if the send email already left (`provider_message_id` set),
 * a cancellation notice is enqueued instead.
 *
 * Sprint 8b D5: a PO with ANY `posted` receipt cannot be cancelled (stock is booked)
 * — it returns `has_receipts`. Voiding every receipt recomputes the PO back to `sent`,
 * at which point cancel is allowed again. Must run inside `withOrg`.
 */
export async function cancelPurchaseOrder(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<CancelOutcome> {
  const [locked] = await db
    .select({ status: purchaseOrders.status })
    .from(purchaseOrders)
    .where(
      and(eq(purchaseOrders.organizationId, organizationId), eq(purchaseOrders.id, id)),
    )
    .for('update')
    .limit(1);
  if (!locked) return { status: 'not_found' };

  // Already cancelled → idempotent no-op (return the current row).
  if (locked.status === 'cancelled') {
    const [order] = await db
      .select()
      .from(purchaseOrders)
      .where(
        and(eq(purchaseOrders.organizationId, organizationId), eq(purchaseOrders.id, id)),
      )
      .limit(1);
    return order
      ? { status: 'ok', order, cancelNoticeEnqueued: false }
      : { status: 'not_found' };
  }

  // D5: refuse to cancel while any posted receipt exists (stock is booked). The
  // receiving states (partially_received/received) imply a posted receipt, and a
  // `sent` PO whose receipts were all voided has none — so this check, not the status
  // alone, is the gate.
  const [postedReceipt] = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(
      and(
        eq(receipts.organizationId, organizationId),
        eq(receipts.purchaseOrderId, id),
        eq(receipts.status, 'posted'),
      ),
    )
    .limit(1);
  if (postedReceipt) return { status: 'has_receipts' };

  const wasSent = locked.status === 'sent';

  const [order] = await db
    .update(purchaseOrders)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(purchaseOrders.organizationId, organizationId),
        eq(purchaseOrders.id, id),
        sql`${purchaseOrders.status} in ('draft', 'sent')`,
      ),
    )
    .returning();
  if (!order) return { status: 'not_found' };

  let cancelNoticeEnqueued = false;
  if (wasSent) {
    // Stop any un-sent send email; if it already left, send a cancellation notice.
    const cancelledRows = await cancelPendingOutbox(
      db,
      organizationId,
      'purchase_order',
      id,
    );
    if (cancelledRows === 0 && order.supplierEmail?.trim()) {
      await enqueueEmail(db, organizationId, {
        documentType: 'purchase_order',
        documentId: id,
        toEmail: order.supplierEmail.trim(),
        subject: null,
        dedupKey: `purchase_order:${id}:cancel`,
      });
      cancelNoticeEnqueued = true;
    }
  }

  return { status: 'ok', order, cancelNoticeEnqueued };
}

/** Hard-deletes a DRAFT PO (gaps tolerated); its line items cascade. */
export async function deleteDraftPurchaseOrder(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<boolean> {
  const [row] = await db
    .delete(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.organizationId, organizationId),
        eq(purchaseOrders.id, id),
        eq(purchaseOrders.status, 'draft'),
      ),
    )
    .returning({ id: purchaseOrders.id });
  return Boolean(row);
}

/**
 * True when `err` is a Postgres unique-violation on the named constraint. Tolerant
 * of the different error shapes across drivers (neon-serverless vs PGlite): it
 * inspects the error and its `cause`, matching either SQLSTATE 23505 + constraint or
 * the constraint name appearing in the message text.
 */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {
    code?: string;
    constraint?: string;
    message?: string;
    cause?: { code?: string; constraint?: string; message?: string };
  };
  const text = `${e.message ?? ''} ${e.cause?.message ?? ''}`;
  const codeMatch = e.code === '23505' || e.cause?.code === '23505';
  const nameMatch =
    e.constraint === constraint ||
    e.cause?.constraint === constraint ||
    text.includes(constraint);
  return (codeMatch || /duplicate key|unique constraint/i.test(text)) && nameMatch;
}
