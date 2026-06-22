import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '@/lib/db/schema';
import { emailOutbox } from '@/lib/db/schema';
import { runInOrg, type TenantDb } from '@/lib/db/tenant';
import { createIngredient } from '@/lib/data/ingredients';
import { createSupplier } from '@/lib/data/suppliers';
import {
  createDraftPurchaseOrder,
  getPurchaseOrderWithItems,
  sendPurchaseOrder,
} from '@/lib/data/purchase-orders';
import { claimDueOutbox, enqueueEmail } from '@/lib/data/email-outbox';

/**
 * REAL-Postgres concurrency proof for Sprint 8a (opt-in; PGlite is single-connection
 * and cannot run two transactions at once). Set `TEST_DATABASE_URL` to a disposable
 * Neon branch with migrations + RLS applied. Without it the whole suite is skipped.
 *
 * Properties proven:
 *  - two concurrent sends of one draft → exactly one succeeds, one outbox row;
 *  - two workers claiming one batch (`FOR UPDATE SKIP LOCKED`) never grab the same
 *    row (disjoint claim sets).
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (typeof globalThis.WebSocket === 'undefined') {
  neonConfig.webSocketConstructor = ws;
}

describe.skipIf(!TEST_DATABASE_URL)('purchase orders under real Postgres', () => {
  const ORG = `org_po_conc_${Date.now()}`;
  let pool: Pool;
  let db: TenantDb;

  beforeAll(() => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    db = drizzle(pool, { schema }) as unknown as TenantDb;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('two concurrent sends of one draft → one ok, one not_draft, one outbox row', async () => {
    const supplier = await runInOrg(db, ORG, (tx) =>
      createSupplier(tx, ORG, {
        name: `Conc Co ${Date.now()}`,
        email: 'c@c.test',
        phone: null,
        address: null,
        taxId: null,
        notes: null,
      }),
    );
    if (supplier.status !== 'ok') throw new Error('supplier');
    const ing = await runInOrg(db, ORG, (tx) =>
      createIngredient(tx, ORG, { name: `Ing ${Date.now()}`, dimension: 'weight', priceCents: 10 }),
    );
    const created = await runInOrg(db, ORG, (tx) =>
      createDraftPurchaseOrder(tx, ORG, {
        supplierId: supplier.supplier.id,
        expectedDate: null,
        notes: null,
        items: [{ ingredientId: ing.id, quantity: 1000, unitCostCents: 50 }],
      }),
    );
    if (created.status !== 'ok') throw new Error('create');
    const poId = created.order.id;

    const [a, b] = await Promise.all([
      runInOrg(db, ORG, (tx) => sendPurchaseOrder(tx, ORG, poId)),
      runInOrg(db, ORG, (tx) => sendPurchaseOrder(tx, ORG, poId)),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['not_draft', 'ok']);

    const detail = await runInOrg(db, ORG, (tx) =>
      getPurchaseOrderWithItems(tx, ORG, poId),
    );
    expect(detail?.order.status).toBe('sent');

    const outbox = await runInOrg(db, ORG, (tx) =>
      tx.select().from(emailOutbox).where(eq(emailOutbox.documentId, poId)),
    );
    expect(outbox).toHaveLength(1);
  });

  it('two workers claim a batch without overlap (SKIP LOCKED)', async () => {
    const docPrefix = `batch_${Date.now()}`;
    for (let i = 0; i < 10; i++) {
      await runInOrg(db, ORG, (tx) =>
        enqueueEmail(tx, ORG, {
          documentType: 'purchase_order',
          documentId: `${docPrefix}_${i}`,
          toEmail: 'x@x.test',
          subject: null,
          dedupKey: `${docPrefix}:${i}:send`,
        }),
      );
    }
    const now = new Date(Date.now() + 1000);

    const [w1, w2] = await Promise.all([
      runInOrg(db, ORG, (tx) => claimDueOutbox(tx, ORG, now, 'worker-1', 10)),
      runInOrg(db, ORG, (tx) => claimDueOutbox(tx, ORG, now, 'worker-2', 10)),
    ]);

    const ids1 = new Set(w1.map((r) => r.id));
    const ids2 = new Set(w2.map((r) => r.id));
    for (const id of ids1) expect(ids2.has(id)).toBe(false);
  });
});
