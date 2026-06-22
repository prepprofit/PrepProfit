import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import {
  emailOutbox,
  ingredients,
  organizationSettings,
  purchaseOrderItems,
  purchaseOrders,
  suppliers as suppliersTable,
} from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { createIngredient } from '@/lib/data/ingredients';
import { createSupplier } from '@/lib/data/suppliers';
import { purgeExpired } from '@/lib/data/trash';
import {
  cancelPurchaseOrder,
  createDraftPurchaseOrder,
  deleteDraftPurchaseOrder,
  getPurchaseOrderWithItems,
  sendPurchaseOrder,
  updateDraftPurchaseOrder,
} from '@/lib/data/purchase-orders';

/**
 * Purchase orders (Sprint 8a) under the non-privileged `tenant_app` role so RLS is
 * enforced. Proves: number allocation + currency freeze + draft totals; draft edit;
 * send freezes the supplier + line snapshot + totals and flips status; immutability
 * after send; the send guards (no supplier / inactive / empty / missing line
 * ingredient); single idempotent outbox enqueue; manual number edit + collision;
 * cancel transitions; cross-org isolation; and the F3 purge-block.
 */
const ORG_A = 'org_po_a';
const ORG_B = 'org_po_b';

let client: PGlite;
let db: TenantDb;

const supplierInput = (name: string, email: string | null = null) => ({
  name,
  email,
  phone: null,
  address: null,
  taxId: null,
  notes: null,
});

async function makeSupplier(org: string, name: string, email: string | null = null) {
  const r = await runInOrg(db, org, (tx) =>
    createSupplier(tx, org, supplierInput(name, email)),
  );
  if (r.status !== 'ok') throw new Error(`supplier ${name}: ${r.status}`);
  return r.supplier;
}

async function makeIngredient(
  org: string,
  name: string,
  dimension: 'weight' | 'volume' | 'count' = 'weight',
  priceCents = 0,
) {
  return runInOrg(db, org, (tx) =>
    createIngredient(tx, org, { name, dimension, priceCents }),
  );
}

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  await db.execute(sql.raw('SET ROLE tenant_app;'));
  // ORG_A pins its currency to USD so the freeze-at-create is observable.
  await runInOrg(db, ORG_A, (tx) =>
    tx.insert(organizationSettings).values({
      organizationId: ORG_A,
      currency: 'USD',
      measurementSystem: 'metric',
    }),
  );
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

describe('createDraftPurchaseOrder', () => {
  it('allocates a number, freezes currency, stores draft totals', async () => {
    const supplier = await makeSupplier(ORG_A, 'ACME Foods', 'orders@acme.test');
    const flour = await makeIngredient(ORG_A, 'Flour', 'weight', 100);

    const result = await runInOrg(db, ORG_A, (tx) =>
      createDraftPurchaseOrder(tx, ORG_A, {
        supplierId: supplier.id,
        expectedDate: null,
        notes: null,
        items: [{ ingredientId: flour.id, quantity: 25000, unitCostCents: 80 }],
      }),
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.order.number).toBeGreaterThan(0);
    expect(result.order.currencyCode).toBe('USD');
    expect(result.order.status).toBe('draft');
    // 80 c/kg × 25000 g / 1000 = 2000 c, non-zero before send.
    expect(result.order.totalCents).toBe(2000);
  });

  it('rejects a line referencing a missing ingredient', async () => {
    const supplier = await makeSupplier(ORG_A, 'Bogus Supplier');
    const result = await runInOrg(db, ORG_A, (tx) =>
      createDraftPurchaseOrder(tx, ORG_A, {
        supplierId: supplier.id,
        expectedDate: null,
        notes: null,
        items: [{ ingredientId: 'does-not-exist', quantity: 1, unitCostCents: 10 }],
      }),
    );
    expect(result.status).toBe('invalid');
  });
});

describe('sendPurchaseOrder', () => {
  it('freezes supplier + line snapshot + totals, flips status, enqueues one email', async () => {
    const supplier = await makeSupplier(ORG_A, 'Send Co', 'po@send.test');
    const sugar = await makeIngredient(ORG_A, 'Sugar', 'weight', 200);
    const created = await runInOrg(db, ORG_A, (tx) =>
      createDraftPurchaseOrder(tx, ORG_A, {
        supplierId: supplier.id,
        expectedDate: null,
        notes: null,
        items: [{ ingredientId: sugar.id, quantity: 10000, unitCostCents: 150 }],
      }),
    );
    if (created.status !== 'ok') throw new Error('create failed');
    const poId = created.order.id;

    const sent = await runInOrg(db, ORG_A, (tx) => sendPurchaseOrder(tx, ORG_A, poId));
    expect(sent.status).toBe('ok');
    if (sent.status !== 'ok') return;
    expect(sent.order.status).toBe('sent');
    expect(sent.order.supplierName).toBe('Send Co');
    expect(sent.order.supplierEmail).toBe('po@send.test');
    expect(sent.order.orderDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sent.enqueuedEmail).toBe(true);

    const detail = await runInOrg(db, ORG_A, (tx) =>
      getPurchaseOrderWithItems(tx, ORG_A, poId),
    );
    expect(detail?.items[0]?.ingredientName).toBe('Sugar');
    expect(detail?.items[0]?.dimension).toBe('weight');
    // 150 c/kg × 10000 g / 1000 = 1500 c.
    expect(detail?.items[0]?.lineTotalCents).toBe(1500);

    const outbox = await runInOrg(db, ORG_A, (tx) =>
      tx.select().from(emailOutbox).where(eq(emailOutbox.documentId, poId)),
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.dedupKey).toBe(`purchase_order:${poId}:send`);
    expect(outbox[0]?.toEmail).toBe('po@send.test');

    // Editing the supplier + ingredient afterwards leaves the sent PO unchanged.
    await runInOrg(db, ORG_A, (tx) =>
      tx
        .update(suppliersTable)
        .set({ name: 'RENAMED', email: 'changed@x.test' })
        .where(eq(suppliersTable.id, supplier.id)),
    );
    await runInOrg(db, ORG_A, (tx) =>
      tx.update(ingredients).set({ name: 'NOTSUGAR' }).where(eq(ingredients.id, sugar.id)),
    );
    const after = await runInOrg(db, ORG_A, (tx) =>
      getPurchaseOrderWithItems(tx, ORG_A, poId),
    );
    expect(after?.order.supplierName).toBe('Send Co');
    expect(after?.items[0]?.ingredientName).toBe('Sugar');
  });

  it('edit/delete after send → not_draft; re-send → not_draft', async () => {
    const supplier = await makeSupplier(ORG_A, 'Immutable Co', 'x@imm.test');
    const ing = await makeIngredient(ORG_A, 'Salt', 'weight', 50);
    const created = await runInOrg(db, ORG_A, (tx) =>
      createDraftPurchaseOrder(tx, ORG_A, {
        supplierId: supplier.id,
        expectedDate: null,
        notes: null,
        items: [{ ingredientId: ing.id, quantity: 1000, unitCostCents: 50 }],
      }),
    );
    if (created.status !== 'ok') throw new Error('create failed');
    const poId = created.order.id;
    await runInOrg(db, ORG_A, (tx) => sendPurchaseOrder(tx, ORG_A, poId));

    const upd = await runInOrg(db, ORG_A, (tx) =>
      updateDraftPurchaseOrder(tx, ORG_A, poId, {
        supplierId: supplier.id,
        expectedDate: null,
        notes: 'x',
        items: [{ ingredientId: ing.id, quantity: 1, unitCostCents: 1 }],
      }),
    );
    expect(upd.status).toBe('not_draft');

    const del = await runInOrg(db, ORG_A, (tx) =>
      deleteDraftPurchaseOrder(tx, ORG_A, poId),
    );
    expect(del).toBe(false);

    const resend = await runInOrg(db, ORG_A, (tx) => sendPurchaseOrder(tx, ORG_A, poId));
    expect(resend.status).toBe('not_draft');
  });

  it('guards: no supplier / empty / inactive / missing line ingredient', async () => {
    const ing = await makeIngredient(ORG_A, 'Yeast', 'weight', 10);
    const before = await runInOrg(db, ORG_A, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(emailOutbox),
    );

    // No supplier.
    const noSup = await runInOrg(db, ORG_A, async (tx) => {
      const c = await createDraftPurchaseOrder(tx, ORG_A, {
        supplierId: null,
        expectedDate: null,
        notes: null,
        items: [{ ingredientId: ing.id, quantity: 100, unitCostCents: 10 }],
      });
      if (c.status !== 'ok') throw new Error('create');
      return sendPurchaseOrder(tx, ORG_A, c.order.id);
    });
    expect(noSup.status).toBe('no_supplier');

    // Empty.
    const supplier = await makeSupplier(ORG_A, 'Empty Co', 'e@e.test');
    const empty = await runInOrg(db, ORG_A, async (tx) => {
      const c = await createDraftPurchaseOrder(tx, ORG_A, {
        supplierId: supplier.id,
        expectedDate: null,
        notes: null,
        items: [],
      });
      if (c.status !== 'ok') throw new Error('create');
      return sendPurchaseOrder(tx, ORG_A, c.order.id);
    });
    expect(empty.status).toBe('empty');

    // Inactive supplier.
    const arch = await makeSupplier(ORG_A, 'Archived Co', 'a@a.test');
    const inactive = await runInOrg(db, ORG_A, async (tx) => {
      const c = await createDraftPurchaseOrder(tx, ORG_A, {
        supplierId: arch.id,
        expectedDate: null,
        notes: null,
        items: [{ ingredientId: ing.id, quantity: 100, unitCostCents: 10 }],
      });
      if (c.status !== 'ok') throw new Error('create');
      await tx
        .update(suppliersTable)
        .set({ active: false })
        .where(eq(suppliersTable.id, arch.id));
      return sendPurchaseOrder(tx, ORG_A, c.order.id);
    });
    expect(inactive.status).toBe('supplier_inactive');

    // Missing line ingredient (trashed before send).
    const supplier2 = await makeSupplier(ORG_A, 'Trash Co', 't@t.test');
    const trashIng = await makeIngredient(ORG_A, 'Doomed', 'weight', 10);
    const missing = await runInOrg(db, ORG_A, async (tx) => {
      const c = await createDraftPurchaseOrder(tx, ORG_A, {
        supplierId: supplier2.id,
        expectedDate: null,
        notes: null,
        items: [{ ingredientId: trashIng.id, quantity: 100, unitCostCents: 10 }],
      });
      if (c.status !== 'ok') throw new Error('create');
      await tx
        .update(ingredients)
        .set({ deletedAt: new Date() })
        .where(eq(ingredients.id, trashIng.id));
      return sendPurchaseOrder(tx, ORG_A, c.order.id);
    });
    expect(missing.status).toBe('line_ingredient_missing');

    // No email queued for any of the failed sends.
    const after = await runInOrg(db, ORG_A, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(emailOutbox),
    );
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it('send without a supplier email still flips to sent (no outbox row)', async () => {
    const supplier = await makeSupplier(ORG_A, 'No Email Co', null);
    const ing = await makeIngredient(ORG_A, 'Butter', 'weight', 30);
    const sent = await runInOrg(db, ORG_A, async (tx) => {
      const c = await createDraftPurchaseOrder(tx, ORG_A, {
        supplierId: supplier.id,
        expectedDate: null,
        notes: null,
        items: [{ ingredientId: ing.id, quantity: 1000, unitCostCents: 30 }],
      });
      if (c.status !== 'ok') throw new Error('create');
      return sendPurchaseOrder(tx, ORG_A, c.order.id);
    });
    expect(sent.status).toBe('ok');
    if (sent.status === 'ok') expect(sent.enqueuedEmail).toBe(false);
  });
});

describe('manual number edit', () => {
  it('rejects a collision and advances the counter on a valid edit', async () => {
    const supplier = await makeSupplier(ORG_A, 'Number Co', 'n@n.test');
    const ing = await makeIngredient(ORG_A, 'NumIng', 'weight', 10);
    const mk = () =>
      runInOrg(db, ORG_A, (tx) =>
        createDraftPurchaseOrder(tx, ORG_A, {
          supplierId: supplier.id,
          expectedDate: null,
          notes: null,
          items: [{ ingredientId: ing.id, quantity: 100, unitCostCents: 10 }],
        }),
      );
    const a = await mk();
    const b = await mk();
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('create');

    // Edit B's number to A's number → collision.
    const taken = await runInOrg(db, ORG_A, (tx) =>
      updateDraftPurchaseOrder(tx, ORG_A, b.order.id, {
        supplierId: supplier.id,
        number: a.order.number,
        expectedDate: null,
        notes: null,
        items: [{ ingredientId: ing.id, quantity: 100, unitCostCents: 10 }],
      }),
    );
    expect(taken.status).toBe('number_taken');

    // Edit B to a high free number → counter advances so the next alloc clears it.
    const high = 9000;
    const ok = await runInOrg(db, ORG_A, (tx) =>
      updateDraftPurchaseOrder(tx, ORG_A, b.order.id, {
        supplierId: supplier.id,
        number: high,
        expectedDate: null,
        notes: null,
        items: [{ ingredientId: ing.id, quantity: 100, unitCostCents: 10 }],
      }),
    );
    expect(ok.status).toBe('ok');
    const next = await mk();
    if (next.status === 'ok') expect(next.order.number).toBeGreaterThan(high);
  });
});

describe('cancelPurchaseOrder', () => {
  it('cancels a sent PO and is idempotent', async () => {
    const supplier = await makeSupplier(ORG_A, 'Cancel Co', 'c@c.test');
    const ing = await makeIngredient(ORG_A, 'CancelIng', 'weight', 10);
    const poId = await runInOrg(db, ORG_A, async (tx) => {
      const c = await createDraftPurchaseOrder(tx, ORG_A, {
        supplierId: supplier.id,
        expectedDate: null,
        notes: null,
        items: [{ ingredientId: ing.id, quantity: 100, unitCostCents: 10 }],
      });
      if (c.status !== 'ok') throw new Error('create');
      await sendPurchaseOrder(tx, ORG_A, c.order.id);
      return c.order.id;
    });

    const c1 = await runInOrg(db, ORG_A, (tx) => cancelPurchaseOrder(tx, ORG_A, poId));
    expect(c1.status).toBe('ok');
    if (c1.status === 'ok') expect(c1.order.status).toBe('cancelled');

    const c2 = await runInOrg(db, ORG_A, (tx) => cancelPurchaseOrder(tx, ORG_A, poId));
    expect(c2.status).toBe('ok'); // idempotent

    // The un-sent outbox row was cancelled (worker will skip it).
    const outbox = await runInOrg(db, ORG_A, (tx) =>
      tx.select().from(emailOutbox).where(eq(emailOutbox.documentId, poId)),
    );
    expect(outbox[0]?.status).toBe('cancelled');
  });
});

describe('cross-org isolation', () => {
  it('ORG_B cannot see or load ORG_A purchase orders', async () => {
    const supplier = await makeSupplier(ORG_A, 'IsoA Co', 'iso@a.test');
    const ing = await makeIngredient(ORG_A, 'IsoIng', 'weight', 10);
    const created = await runInOrg(db, ORG_A, (tx) =>
      createDraftPurchaseOrder(tx, ORG_A, {
        supplierId: supplier.id,
        expectedDate: null,
        notes: null,
        items: [{ ingredientId: ing.id, quantity: 100, unitCostCents: 10 }],
      }),
    );
    if (created.status !== 'ok') throw new Error('create');

    const seenFromB = await runInOrg(db, ORG_B, (tx) =>
      getPurchaseOrderWithItems(tx, ORG_B, created.order.id),
    );
    expect(seenFromB).toBeNull();

    const rowsB = await runInOrg(db, ORG_B, (tx) =>
      tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, created.order.id)),
    );
    expect(rowsB).toHaveLength(0);
  });
});

describe('F3 purge-block', () => {
  it('keeps an ingredient referenced by a SENT PO; purges a draft-only ref and nulls the link', async () => {
    const cutoff = new Date(Date.now() + 60_000); // everything trashed is "expired"
    const supplier = await makeSupplier(ORG_A, 'Purge Co', 'p@p.test');

    // (1) Ingredient on a SENT PO → kept on purge.
    const keep = await makeIngredient(ORG_A, 'Keeper', 'weight', 10);
    await runInOrg(db, ORG_A, async (tx) => {
      const c = await createDraftPurchaseOrder(tx, ORG_A, {
        supplierId: supplier.id,
        expectedDate: null,
        notes: null,
        items: [{ ingredientId: keep.id, quantity: 100, unitCostCents: 10 }],
      });
      if (c.status !== 'ok') throw new Error('create');
      await sendPurchaseOrder(tx, ORG_A, c.order.id);
      await tx
        .update(ingredients)
        .set({ deletedAt: new Date() })
        .where(eq(ingredients.id, keep.id));
    });

    // (2) Ingredient on a DRAFT-only PO → purged, draft link nulled.
    const drop = await makeIngredient(ORG_A, 'Dropper', 'weight', 10);
    const draftPoId = await runInOrg(db, ORG_A, async (tx) => {
      const c = await createDraftPurchaseOrder(tx, ORG_A, {
        supplierId: supplier.id,
        expectedDate: null,
        notes: null,
        items: [{ ingredientId: drop.id, quantity: 100, unitCostCents: 10 }],
      });
      if (c.status !== 'ok') throw new Error('create');
      await tx
        .update(ingredients)
        .set({ deletedAt: new Date() })
        .where(eq(ingredients.id, drop.id));
      return c.order.id;
    });

    await runInOrg(db, ORG_A, (tx) => purgeExpired(tx, ORG_A, cutoff));

    const keptRow = await runInOrg(db, ORG_A, (tx) =>
      tx.select().from(ingredients).where(eq(ingredients.id, keep.id)),
    );
    expect(keptRow).toHaveLength(1); // kept — referenced by a sent PO

    const droppedRow = await runInOrg(db, ORG_A, (tx) =>
      tx.select().from(ingredients).where(eq(ingredients.id, drop.id)),
    );
    expect(droppedRow).toHaveLength(0); // purged — only a draft referenced it

    const draftLine = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select()
        .from(purchaseOrderItems)
        .where(eq(purchaseOrderItems.purchaseOrderId, draftPoId)),
    );
    expect(draftLine[0]?.ingredientId).toBeNull(); // link nulled
  });
});
