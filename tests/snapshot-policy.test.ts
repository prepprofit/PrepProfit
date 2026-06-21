import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import {
  createDraftInvoice,
  getInvoiceWithItems,
  issueInvoice,
} from '@/lib/data/invoices';
import { createCustomer, updateCustomer } from '@/lib/data/customers';

/**
 * Snapshot-on-issue policy (Sprint F3, Policy A in docs/document-snapshot-policy.md).
 *
 * The ONE behavioural case that was missing: prove an issued document is immutable
 * against a later EDIT of the master it snapshotted. (The purge case — keeping the
 * snapshot after the customer is deleted — is already covered by the trash/invoice
 * tests.) Invoices are the only issued document that exists today, so they stand in
 * for every future document (PO / sale / production) that will follow the same
 * snapshot pattern via lib/documents/snapshots.ts.
 */

const ORG = 'org_snapshot';

let client: PGlite;
let db: TenantDb;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
});

afterAll(async () => {
  await client.close();
});

describe('snapshot-on-issue — editing the master after issue does not change the document', () => {
  it('freezes the customer snapshot at issue; later customer edits are not reflected', async () => {
    const customer = await createCustomer(db, ORG, {
      name: 'Original Bistro',
      taxId: 'PT123456789',
      address: '1 Old Street',
      email: 'original@bistro.test',
    });

    const draft = await createDraftInvoice(db, ORG, {
      customerId: customer.id,
      notes: null,
      items: [
        { description: 'Catering', quantity: 1, unitPriceCents: 10000, taxRate: 23 },
      ],
    });

    const issued = await issueInvoice(
      db,
      ORG,
      draft.id,
      null,
      new Date('2026-06-21T10:00:00Z'),
    );
    expect(issued.status).toBe('ok');
    if (issued.status !== 'ok') return;

    // The snapshot is captured at issue, inside the issue transaction.
    expect(issued.invoice.customerName).toBe('Original Bistro');
    expect(issued.invoice.customerTaxId).toBe('PT123456789');
    expect(issued.invoice.customerAddress).toBe('1 Old Street');
    expect(issued.invoice.customerEmail).toBe('original@bistro.test');

    // Now EDIT the live master — every field changes.
    const renamed = await updateCustomer(db, ORG, customer.id, {
      name: 'Renamed Trattoria',
      taxId: 'PT999999999',
      address: '99 New Avenue',
      email: 'renamed@trattoria.test',
    });
    expect(renamed?.name).toBe('Renamed Trattoria');

    // Re-read the issued invoice: the frozen snapshot must be UNCHANGED, while the
    // live link still points at the (now-renamed) customer row.
    const after = await getInvoiceWithItems(db, ORG, draft.id);
    expect(after).not.toBeNull();
    if (!after) return;

    expect(after.invoice.customerName).toBe('Original Bistro');
    expect(after.invoice.customerTaxId).toBe('PT123456789');
    expect(after.invoice.customerAddress).toBe('1 Old Street');
    expect(after.invoice.customerEmail).toBe('original@bistro.test');
    // The live link is intact (the document still knows WHICH customer it was),
    // but the historical billing detail is the frozen one above, not the live row.
    expect(after.invoice.customerId).toBe(customer.id);

    // Frozen monetary totals are likewise immutable.
    expect(after.invoice.totalCents).toBe(12300); // 10000 + 23%
  });
});
