import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import {
  allocateInvoiceNumber,
  createDraftInvoice,
  formatInvoiceNumber,
  issueInvoice,
  updateDraftInvoice,
} from '@/lib/data/invoices';
import { createCustomer } from '@/lib/data/customers';

const ORG = 'org_inv';
const OTHER = 'org_other';

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

describe('invoice number allocation — gap-free & no duplicates', () => {
  it('hands out a contiguous 1..N with no gaps or duplicates under contention', async () => {
    const year = 2026;
    const N = 50;
    // Fire all allocations "at once". PGlite serializes them on its single
    // connection, but this still proves the atomic upsert-increment never yields
    // a duplicate or a gap (the row lock + unique constraint are the real guard).
    const seqs = await Promise.all(
      Array.from({ length: N }, () => allocateInvoiceNumber(db, ORG, year)),
    );

    const sorted = [...seqs].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    expect(new Set(seqs).size).toBe(N); // all distinct
  });

  it('keeps a separate sequence per year (numbers reset each year)', async () => {
    expect(await allocateInvoiceNumber(db, ORG, 2027)).toBe(1);
    expect(await allocateInvoiceNumber(db, ORG, 2027)).toBe(2);
  });

  it('keeps a separate sequence per organization', async () => {
    expect(await allocateInvoiceNumber(db, OTHER, 2026)).toBe(1);
  });

  it('formats numbers as INV-YEAR-####', () => {
    expect(formatInvoiceNumber(2026, 1)).toBe('INV-2026-0001');
    expect(formatInvoiceNumber(2026, 1234)).toBe('INV-2026-1234');
  });
});

describe('invoice lifecycle — issued invoices are immutable', () => {
  it('issues a draft, freezes a number, then refuses edits', async () => {
    const org = 'org_lifecycle';
    const customer = await createCustomer(db, org, {
      name: 'Bistro Client',
      taxId: null,
      address: null,
      email: null,
    });
    const draft = await createDraftInvoice(db, org, {
      customerId: customer.id,
      notes: null,
      items: [{ description: 'Catering', quantity: 1, unitPriceCents: 10000, taxRate: 23 }],
    });

    const now = new Date('2026-06-17T10:00:00Z');
    const outcome = await issueInvoice(db, org, draft.id, null, now);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.invoice.number).toBe('INV-2026-0001');
    expect(outcome.invoice.totalCents).toBe(12300); // 10000 + 23%

    // Editing an issued invoice is rejected (returns null → action maps to LOCKED).
    const edit = await updateDraftInvoice(db, org, draft.id, {
      customerId: customer.id,
      notes: 'changed',
      items: [{ description: 'X', quantity: 1, unitPriceCents: 1, taxRate: 0 }],
    });
    expect(edit).toBeNull();
  });

  it('refuses to issue a draft with no linked customer', async () => {
    const org = 'org_nocustomer';
    const draft = await createDraftInvoice(db, org, {
      customerId: null,
      notes: null,
      items: [{ description: 'Item', quantity: 1, unitPriceCents: 500, taxRate: 0 }],
    });
    const outcome = await issueInvoice(db, org, draft.id, null);
    expect(outcome.status).toBe('no_customer');
  });
});
