import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '@/lib/db/schema';
import { ingredients } from '@/lib/db/schema';
import { runInOrg, type TenantDb } from '@/lib/db/tenant';
import { createIngredient } from '@/lib/data/ingredients';
import { createSupplier } from '@/lib/data/suppliers';
import {
  createDraftPurchaseOrder,
  getPurchaseOrderWithItems,
  sendPurchaseOrder,
} from '@/lib/data/purchase-orders';
import { postReceipt } from '@/lib/data/receipts';

/**
 * REAL-Postgres concurrency proof for Sprint 8b (opt-in; PGlite is single-connection
 * and cannot run two transactions at once). Set `TEST_DATABASE_URL` to a disposable
 * Neon branch with migrations + RLS applied. Without it the whole suite is skipped.
 *
 * Properties proven:
 *  - two concurrent `postReceipt` with the SAME client mutation id apply the receipt
 *    exactly once (form-level idempotency under a real race) — stock moves once;
 *  - two concurrent receipts on the same PO sharing an ingredient both apply and
 *    reconcile to the summed stock (deterministic id-asc lock order, no deadlock).
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (typeof globalThis.WebSocket === 'undefined') {
  neonConfig.webSocketConstructor = ws;
}

describe.skipIf(!TEST_DATABASE_URL)('receipts under real Postgres', () => {
  const ORG = `org_rcpt_conc_${Date.now()}`;
  let pool: Pool;
  let db: TenantDb;

  beforeAll(() => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    db = drizzle(pool, { schema }) as unknown as TenantDb;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function sentPo(ingredientId: string, quantity: number) {
    const supplier = await runInOrg(db, ORG, (tx) =>
      createSupplier(tx, ORG, {
        name: `Conc Co ${Date.now()}-${Math.random()}`,
        email: null,
        phone: null,
        address: null,
        taxId: null,
        notes: null,
      }),
    );
    if (supplier.status !== 'ok') throw new Error('supplier');
    const created = await runInOrg(db, ORG, (tx) =>
      createDraftPurchaseOrder(tx, ORG, {
        supplierId: supplier.supplier.id,
        expectedDate: null,
        notes: null,
        items: [{ ingredientId, quantity, unitCostCents: 50 }],
      }),
    );
    if (created.status !== 'ok') throw new Error('create');
    const sent = await runInOrg(db, ORG, (tx) =>
      sendPurchaseOrder(tx, ORG, created.order.id),
    );
    if (sent.status !== 'ok') throw new Error('send');
    const detail = await runInOrg(db, ORG, (tx) =>
      getPurchaseOrderWithItems(tx, ORG, created.order.id),
    );
    return detail!;
  }

  async function stockOf(ingredientId: string) {
    const [row] = await runInOrg(db, ORG, (tx) =>
      tx
        .select({ stock: ingredients.stockQuantity })
        .from(ingredients)
        .where(and(eq(ingredients.organizationId, ORG), eq(ingredients.id, ingredientId)))
        .limit(1),
    );
    return Number(row!.stock);
  }

  it('same client mutation id raced → receipt applied exactly once', async () => {
    const ing = await runInOrg(db, ORG, (tx) =>
      createIngredient(tx, ORG, { name: `Ing ${Date.now()}`, dimension: 'weight', priceCents: 0 }),
    );
    const po = await sentPo(ing.id, 10000);
    const input = {
      purchaseOrderId: po.order.id,
      receivedDate: '2026-06-22',
      notes: null,
      clientMutationId: `mut-${Date.now()}`,
      items: [
        { purchaseOrderItemId: po.items[0]!.id, receivedQuantity: 4000, receivedUnitCostCents: 50 },
      ],
    };

    const results = await Promise.allSettled([
      runInOrg(db, ORG, (tx) => postReceipt(tx, ORG, 'u', input)),
      runInOrg(db, ORG, (tx) => postReceipt(tx, ORG, 'u', input)),
    ]);
    // Both calls resolve ok (one inserts, the other dedups or loses the unique race
    // and is retried as a dedup); a unique-violation throw is also acceptable as the
    // "exactly once" backstop. Either way, stock must have moved only once.
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(await stockOf(ing.id)).toBe(4000);
  });

  it('two receipts sharing an ingredient reconcile to the summed stock', async () => {
    const ing = await runInOrg(db, ORG, (tx) =>
      createIngredient(tx, ORG, { name: `Shared ${Date.now()}`, dimension: 'weight', priceCents: 0 }),
    );
    const poA = await sentPo(ing.id, 5000);
    const poB = await sentPo(ing.id, 5000);

    await Promise.all([
      runInOrg(db, ORG, (tx) =>
        postReceipt(tx, ORG, 'u', {
          purchaseOrderId: poA.order.id,
          receivedDate: '2026-06-22',
          notes: null,
          clientMutationId: `mutA-${Date.now()}`,
          items: [
            { purchaseOrderItemId: poA.items[0]!.id, receivedQuantity: 3000, receivedUnitCostCents: 50 },
          ],
        }),
      ),
      runInOrg(db, ORG, (tx) =>
        postReceipt(tx, ORG, 'u', {
          purchaseOrderId: poB.order.id,
          receivedDate: '2026-06-22',
          notes: null,
          clientMutationId: `mutB-${Date.now()}`,
          items: [
            { purchaseOrderItemId: poB.items[0]!.id, receivedQuantity: 2000, receivedUnitCostCents: 50 },
          ],
        }),
      ),
    ]);
    expect(await stockOf(ing.id)).toBe(5000);
  });
});
