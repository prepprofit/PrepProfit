import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import {
  ingredients,
  ingredientPriceHistory,
  receipts,
  receiptItems,
} from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { createIngredient } from '@/lib/data/ingredients';
import { createSupplier } from '@/lib/data/suppliers';
import { recordMovement, MovementError } from '@/lib/data/inventory';
import {
  cancelPurchaseOrder,
  createDraftPurchaseOrder,
  getPurchaseOrderWithItems,
  sendPurchaseOrder,
} from '@/lib/data/purchase-orders';
import {
  closePurchaseOrder,
  postReceipt,
  receivedRollup,
  voidReceipt,
} from '@/lib/data/receipts';
import type { PostReceiptInput } from '@/lib/validation/receipts';

/**
 * Goods receipts (Sprint 8b) under the non-privileged `tenant_app` role so RLS is
 * enforced. Proves: partial → full rollup + status; F1 IN movements + F2 pending;
 * D6 form idempotency incl. retry-after-received (B2); over-delivery (D1); void
 * reversal + pending recompute (B3) + reopen (B6); void blocked by stock floor (B4);
 * cross-PO line rejection (B5); cancel blocked with posted receipts (D5); precision
 * reconciliation (B1); and cross-org isolation.
 */
const ORG_A = 'org_rcpt_a';
const ORG_B = 'org_rcpt_b';

let client: PGlite;
let db: TenantDb;

const supplierInput = (name: string) => ({
  name,
  email: null,
  phone: null,
  address: null,
  taxId: null,
  notes: null,
});

async function makeSupplier(org: string, name: string) {
  const r = await runInOrg(db, org, (tx) =>
    createSupplier(tx, org, supplierInput(name)),
  );
  if (r.status !== 'ok') throw new Error(`supplier ${name}: ${r.status}`);
  return r.supplier;
}

async function makeIngredient(
  org: string,
  name: string,
  dimension: 'weight' | 'volume' | 'count' = 'weight',
) {
  return runInOrg(db, org, (tx) =>
    createIngredient(tx, org, { name, dimension, priceCents: 0 }),
  );
}

/** Create a draft PO and send it; returns the sent order + its line items. */
async function makeSentPo(
  org: string,
  lines: { ingredientId: string; quantity: number; unitCostCents: number }[],
) {
  const supplier = await makeSupplier(org, `Supplier ${Math.random()}`);
  const created = await runInOrg(db, org, (tx) =>
    createDraftPurchaseOrder(tx, org, {
      supplierId: supplier.id,
      expectedDate: null,
      notes: null,
      items: lines,
    }),
  );
  if (created.status !== 'ok') throw new Error(`draft: ${created.status}`);
  const sent = await runInOrg(db, org, (tx) =>
    sendPurchaseOrder(tx, org, created.order.id),
  );
  if (sent.status !== 'ok') throw new Error(`send: ${sent.status}`);
  const detail = await runInOrg(db, org, (tx) =>
    getPurchaseOrderWithItems(tx, org, created.order.id),
  );
  if (!detail) throw new Error('detail missing');
  return detail;
}

function receiptInput(
  poId: string,
  items: { purchaseOrderItemId: string; receivedQuantity: number; receivedUnitCostCents: number }[],
  clientMutationId: string,
): PostReceiptInput {
  return {
    purchaseOrderId: poId,
    receivedDate: '2026-06-22',
    notes: null,
    clientMutationId,
    items,
  };
}

async function stockOf(org: string, ingredientId: string): Promise<number> {
  const [row] = await runInOrg(db, org, (tx) =>
    tx
      .select({ stock: ingredients.stockQuantity })
      .from(ingredients)
      .where(and(eq(ingredients.organizationId, org), eq(ingredients.id, ingredientId)))
      .limit(1),
  );
  return Number(row!.stock);
}

async function pendingOf(org: string, ingredientId: string): Promise<number | null> {
  const [row] = await runInOrg(db, org, (tx) =>
    tx
      .select({ pending: ingredients.pendingPriceCents })
      .from(ingredients)
      .where(and(eq(ingredients.organizationId, org), eq(ingredients.id, ingredientId)))
      .limit(1),
  );
  return row!.pending == null ? null : Number(row!.pending);
}

async function poStatus(org: string, poId: string): Promise<string> {
  const detail = await runInOrg(db, org, (tx) =>
    getPurchaseOrderWithItems(tx, org, poId),
  );
  return detail!.order.status;
}

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

describe('postReceipt', () => {
  it('partial then full delivery rolls status and books stock + pending once', async () => {
    const flour = await makeIngredient(ORG_A, 'Flour');
    const po = await makeSentPo(ORG_A, [
      { ingredientId: flour.id, quantity: 10000, unitCostCents: 80 },
    ]);
    const line = po.items[0]!;

    // Partial: receive 6000 g.
    const r1 = await runInOrg(db, ORG_A, (tx) =>
      postReceipt(
        tx,
        ORG_A,
        'user_1',
        receiptInput(po.order.id, [
          { purchaseOrderItemId: line.id, receivedQuantity: 6000, receivedUnitCostCents: 90 },
        ], 'mut-1'),
      ),
    );
    expect(r1.status).toBe('ok');
    expect(await stockOf(ORG_A, flour.id)).toBe(6000);
    expect(await poStatus(ORG_A, po.order.id)).toBe('partially_received');
    // F2: pending raised to the received cost, never price_cents.
    expect(await pendingOf(ORG_A, flour.id)).toBe(90);

    // Provenance: a source='order' history row tagged with the receipt item.
    const history = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select()
        .from(ingredientPriceHistory)
        .where(eq(ingredientPriceHistory.organizationId, ORG_A)),
    );
    expect(history.some((h) => h.source === 'order' && h.sourceReceiptItemId != null)).toBe(
      true,
    );

    // Remainder: receive the other 4000 g → received.
    const r2 = await runInOrg(db, ORG_A, (tx) =>
      postReceipt(
        tx,
        ORG_A,
        'user_1',
        receiptInput(po.order.id, [
          { purchaseOrderItemId: line.id, receivedQuantity: 4000, receivedUnitCostCents: 90 },
        ], 'mut-2'),
      ),
    );
    expect(r2.status).toBe('ok');
    expect(await stockOf(ORG_A, flour.id)).toBe(10000);
    expect(await poStatus(ORG_A, po.order.id)).toBe('received');
    const detail = await runInOrg(db, ORG_A, (tx) =>
      getPurchaseOrderWithItems(tx, ORG_A, po.order.id),
    );
    expect(detail!.order.receivedAt).not.toBeNull();
  });

  it('D6: same mutation id + same payload returns the existing receipt (deduped)', async () => {
    const sugar = await makeIngredient(ORG_A, 'Sugar');
    const po = await makeSentPo(ORG_A, [
      { ingredientId: sugar.id, quantity: 5000, unitCostCents: 50 },
    ]);
    const line = po.items[0]!;
    const input = receiptInput(po.order.id, [
      { purchaseOrderItemId: line.id, receivedQuantity: 5000, receivedUnitCostCents: 50 },
    ], 'mut-dedup');

    const first = await runInOrg(db, ORG_A, (tx) => postReceipt(tx, ORG_A, 'u', input));
    const second = await runInOrg(db, ORG_A, (tx) => postReceipt(tx, ORG_A, 'u', input));
    expect(first.status).toBe('ok');
    expect(second.status).toBe('ok');
    if (first.status === 'ok' && second.status === 'ok') {
      expect(second.deduped).toBe(true);
      expect(second.receipt.id).toBe(first.receipt.id);
    }
    // Stock moved exactly once.
    expect(await stockOf(ORG_A, sugar.id)).toBe(5000);
    // B2: a retry after the PO is already `received` still returns the receipt.
    expect(await poStatus(ORG_A, po.order.id)).toBe('received');
    const retry = await runInOrg(db, ORG_A, (tx) => postReceipt(tx, ORG_A, 'u', input));
    expect(retry.status).toBe('ok');
  });

  it('D6: same mutation id + different payload conflicts', async () => {
    const salt = await makeIngredient(ORG_A, 'Salt');
    const po = await makeSentPo(ORG_A, [
      { ingredientId: salt.id, quantity: 3000, unitCostCents: 20 },
    ]);
    const line = po.items[0]!;
    await runInOrg(db, ORG_A, (tx) =>
      postReceipt(
        tx,
        ORG_A,
        'u',
        receiptInput(po.order.id, [
          { purchaseOrderItemId: line.id, receivedQuantity: 1000, receivedUnitCostCents: 20 },
        ], 'mut-conflict'),
      ),
    );
    const conflict = await runInOrg(db, ORG_A, (tx) =>
      postReceipt(
        tx,
        ORG_A,
        'u',
        receiptInput(po.order.id, [
          { purchaseOrderItemId: line.id, receivedQuantity: 2000, receivedUnitCostCents: 20 },
        ], 'mut-conflict'),
      ),
    );
    expect(conflict.status).toBe('conflict');
  });

  it('D1: over-delivery is allowed', async () => {
    const oil = await makeIngredient(ORG_A, 'Oil', 'volume');
    const po = await makeSentPo(ORG_A, [
      { ingredientId: oil.id, quantity: 1000, unitCostCents: 30 },
    ]);
    const line = po.items[0]!;
    const r = await runInOrg(db, ORG_A, (tx) =>
      postReceipt(
        tx,
        ORG_A,
        'u',
        receiptInput(po.order.id, [
          { purchaseOrderItemId: line.id, receivedQuantity: 1500, receivedUnitCostCents: 30 },
        ], 'mut-over'),
      ),
    );
    expect(r.status).toBe('ok');
    expect(await stockOf(ORG_A, oil.id)).toBe(1500);
    // Over-delivered → counts as fully received.
    expect(await poStatus(ORG_A, po.order.id)).toBe('received');
  });

  it('B1: a fractional canonical receipt reconciles exactly with stock', async () => {
    const yeast = await makeIngredient(ORG_A, 'Yeast');
    const po = await makeSentPo(ORG_A, [
      { ingredientId: yeast.id, quantity: 2, unitCostCents: 1000 },
    ]);
    const line = po.items[0]!;
    await runInOrg(db, ORG_A, (tx) =>
      postReceipt(
        tx,
        ORG_A,
        'u',
        receiptInput(po.order.id, [
          { purchaseOrderItemId: line.id, receivedQuantity: 1.5, receivedUnitCostCents: 1000 },
        ], 'mut-frac'),
      ),
    );
    expect(await stockOf(ORG_A, yeast.id)).toBe(1.5);
  });

  it('rejects a draft (not receivable) and a cross-PO line', async () => {
    // A brand-new draft is not receivable.
    const supplier = await makeSupplier(ORG_A, 'Draft Supplier');
    const ing = await makeIngredient(ORG_A, 'Draft ing');
    const draft = await runInOrg(db, ORG_A, (tx) =>
      createDraftPurchaseOrder(tx, ORG_A, {
        supplierId: supplier.id,
        expectedDate: null,
        notes: null,
        items: [{ ingredientId: ing.id, quantity: 100, unitCostCents: 10 }],
      }),
    );
    if (draft.status !== 'ok') throw new Error('draft');
    const draftDetail = await runInOrg(db, ORG_A, (tx) =>
      getPurchaseOrderWithItems(tx, ORG_A, draft.order.id),
    );
    const notReceivable = await runInOrg(db, ORG_A, (tx) =>
      postReceipt(
        tx,
        ORG_A,
        'u',
        receiptInput(draft.order.id, [
          {
            purchaseOrderItemId: draftDetail!.items[0]!.id,
            receivedQuantity: 50,
            receivedUnitCostCents: 10,
          },
        ], 'mut-draft'),
      ),
    );
    expect(notReceivable.status).toBe('not_receivable');

    // A line from another PO is rejected (B5: resolved against THIS PO's lines).
    const a = await makeIngredient(ORG_A, 'A');
    const b = await makeIngredient(ORG_A, 'B');
    const poA = await makeSentPo(ORG_A, [{ ingredientId: a.id, quantity: 100, unitCostCents: 10 }]);
    const poB = await makeSentPo(ORG_A, [{ ingredientId: b.id, quantity: 100, unitCostCents: 10 }]);
    const cross = await runInOrg(db, ORG_A, (tx) =>
      postReceipt(
        tx,
        ORG_A,
        'u',
        receiptInput(poA.order.id, [
          { purchaseOrderItemId: poB.items[0]!.id, receivedQuantity: 10, receivedUnitCostCents: 10 },
        ], 'mut-cross'),
      ),
    );
    expect(cross.status).toBe('line_ingredient_missing');
  });
});

describe('voidReceipt', () => {
  it('reverses stock, recomputes pending, reopens the PO, and is idempotent', async () => {
    const butter = await makeIngredient(ORG_A, 'Butter');
    const po = await makeSentPo(ORG_A, [
      { ingredientId: butter.id, quantity: 4000, unitCostCents: 200 },
    ]);
    const line = po.items[0]!;
    const posted = await runInOrg(db, ORG_A, (tx) =>
      postReceipt(
        tx,
        ORG_A,
        'u',
        receiptInput(po.order.id, [
          { purchaseOrderItemId: line.id, receivedQuantity: 4000, receivedUnitCostCents: 210 },
        ], 'mut-void'),
      ),
    );
    if (posted.status !== 'ok') throw new Error('post');
    expect(await poStatus(ORG_A, po.order.id)).toBe('received');
    expect(await pendingOf(ORG_A, butter.id)).toBe(210);

    const voided = await runInOrg(db, ORG_A, (tx) =>
      voidReceipt(tx, ORG_A, posted.receipt.id),
    );
    expect(voided.status).toBe('ok');
    // Stock reversed to zero; PO reopened to `sent` (no posted receipts left).
    expect(await stockOf(ORG_A, butter.id)).toBe(0);
    expect(await poStatus(ORG_A, po.order.id)).toBe('sent');
    // B3: pending recomputed away (no valid observation remains).
    expect(await pendingOf(ORG_A, butter.id)).toBeNull();
    // Rollup excludes the voided receipt.
    const rollup = await runInOrg(db, ORG_A, (tx) =>
      receivedRollup(tx, ORG_A, po.order.id),
    );
    expect(rollup.get(line.id) ?? 0).toBe(0);

    // Idempotent second void.
    const again = await runInOrg(db, ORG_A, (tx) =>
      voidReceipt(tx, ORG_A, posted.receipt.id),
    );
    expect(again.status).toBe('ok');
    if (again.status === 'ok') expect(again.alreadyVoided).toBe(true);
  });

  it('B4: void is blocked when the goods were already consumed', async () => {
    const cocoa = await makeIngredient(ORG_A, 'Cocoa');
    const po = await makeSentPo(ORG_A, [
      { ingredientId: cocoa.id, quantity: 5000, unitCostCents: 100 },
    ]);
    const posted = await runInOrg(db, ORG_A, (tx) =>
      postReceipt(
        tx,
        ORG_A,
        'u',
        receiptInput(po.order.id, [
          { purchaseOrderItemId: po.items[0]!.id, receivedQuantity: 5000, receivedUnitCostCents: 100 },
        ], 'mut-consume'),
      ),
    );
    if (posted.status !== 'ok') throw new Error('post');
    // Consume 3000 g via a manual stock-out (stock 5000 → 2000).
    await runInOrg(db, ORG_A, (tx) =>
      recordMovement(tx, ORG_A, {
        ingredientId: cocoa.id,
        deltaCanonical: -3000,
        source: { type: 'manual' },
        idempotencyKey: 'manual:consume-cocoa',
      }),
    );
    // Voiding would drive stock below zero → blocked (throws MovementError).
    await expect(
      runInOrg(db, ORG_A, (tx) => voidReceipt(tx, ORG_A, posted.receipt.id)),
    ).rejects.toBeInstanceOf(MovementError);
    // Receipt is still posted (rolled back); stock unchanged.
    expect(await stockOf(ORG_A, cocoa.id)).toBe(2000);
  });

  it('B6: voiding a short-closed PO reopens it and clears the closure', async () => {
    const milk = await makeIngredient(ORG_A, 'Milk', 'volume');
    const po = await makeSentPo(ORG_A, [
      { ingredientId: milk.id, quantity: 10000, unitCostCents: 10 },
    ]);
    const posted = await runInOrg(db, ORG_A, (tx) =>
      postReceipt(
        tx,
        ORG_A,
        'u',
        receiptInput(po.order.id, [
          { purchaseOrderItemId: po.items[0]!.id, receivedQuantity: 6000, receivedUnitCostCents: 10 },
        ], 'mut-short'),
      ),
    );
    if (posted.status !== 'ok') throw new Error('post');
    const closed = await runInOrg(db, ORG_A, (tx) =>
      closePurchaseOrder(tx, ORG_A, po.order.id, 'Supplier out of stock'),
    );
    expect(closed.status).toBe('ok');
    let detail = await runInOrg(db, ORG_A, (tx) =>
      getPurchaseOrderWithItems(tx, ORG_A, po.order.id),
    );
    expect(detail!.order.status).toBe('received');
    expect(detail!.order.closedReason).toBe('Supplier out of stock');

    await runInOrg(db, ORG_A, (tx) => voidReceipt(tx, ORG_A, posted.receipt.id));
    detail = await runInOrg(db, ORG_A, (tx) =>
      getPurchaseOrderWithItems(tx, ORG_A, po.order.id),
    );
    expect(detail!.order.status).toBe('sent');
    expect(detail!.order.closedReason).toBeNull();
    expect(detail!.order.receivedAt).toBeNull();
  });
});

describe('cancel (D5) + isolation', () => {
  it('blocks cancel while a posted receipt exists, allows it after void', async () => {
    const egg = await makeIngredient(ORG_A, 'Egg', 'count');
    const po = await makeSentPo(ORG_A, [
      { ingredientId: egg.id, quantity: 100, unitCostCents: 25 },
    ]);
    const posted = await runInOrg(db, ORG_A, (tx) =>
      postReceipt(
        tx,
        ORG_A,
        'u',
        receiptInput(po.order.id, [
          { purchaseOrderItemId: po.items[0]!.id, receivedQuantity: 40, receivedUnitCostCents: 25 },
        ], 'mut-cancel'),
      ),
    );
    if (posted.status !== 'ok') throw new Error('post');
    const blocked = await runInOrg(db, ORG_A, (tx) =>
      cancelPurchaseOrder(tx, ORG_A, po.order.id),
    );
    expect(blocked.status).toBe('has_receipts');

    await runInOrg(db, ORG_A, (tx) => voidReceipt(tx, ORG_A, posted.receipt.id));
    const allowed = await runInOrg(db, ORG_A, (tx) =>
      cancelPurchaseOrder(tx, ORG_A, po.order.id),
    );
    expect(allowed.status).toBe('ok');
  });

  it('org B cannot see org A receipts', async () => {
    const ing = await makeIngredient(ORG_A, 'Iso ing');
    const po = await makeSentPo(ORG_A, [
      { ingredientId: ing.id, quantity: 100, unitCostCents: 10 },
    ]);
    await runInOrg(db, ORG_A, (tx) =>
      postReceipt(
        tx,
        ORG_A,
        'u',
        receiptInput(po.order.id, [
          { purchaseOrderItemId: po.items[0]!.id, receivedQuantity: 100, receivedUnitCostCents: 10 },
        ], 'mut-iso'),
      ),
    );
    const fromB = await runInOrg(db, ORG_B, (tx) =>
      tx.select().from(receipts).where(eq(receipts.organizationId, ORG_A)),
    );
    expect(fromB).toHaveLength(0);
    const itemsFromB = await runInOrg(db, ORG_B, (tx) =>
      tx.select().from(receiptItems).where(eq(receiptItems.organizationId, ORG_A)),
    );
    expect(itemsFromB).toHaveLength(0);
  });
});
