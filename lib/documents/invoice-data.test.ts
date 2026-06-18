import { describe, expect, it } from 'vitest';
import { buildInvoiceDocumentData, invoiceDocumentFilename } from './invoice-data';
import type { SellerSettings } from './invoice-data';
import { lineTotals, invoiceTotals } from '@/lib/calculations/invoice';
import type { Invoice, InvoiceItem } from '@/lib/db/schema';

/**
 * The pure invoice document view-model (Sprint 3.5A). Proves the rendered lines
 * reconcile with the shared line math, the frozen totals are used verbatim, the
 * seller name falls back to the org name, and blank fields collapse to null.
 */

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv_1',
    organizationId: 'org_a',
    customerId: null,
    customerName: 'Café Lisboa',
    customerTaxId: 'PT123456789',
    customerAddress: 'Rua das Flores 1, Lisboa',
    customerEmail: 'owner@cafe.pt',
    status: 'issued',
    number: 'INV-2026-0001',
    seq: 1,
    year: 2026,
    issueDate: '2026-06-18',
    dueDate: '2026-07-18',
    paidAt: null,
    subtotalCents: 0,
    taxCents: 0,
    totalCents: 0,
    notes: 'Thank you',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  } as Invoice;
}

function makeItem(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'it_1',
    organizationId: 'org_a',
    invoiceId: 'inv_1',
    description: 'Sourdough loaf',
    quantity: '10',
    unitPriceCents: 350,
    taxRate: '23',
    sortOrder: 0,
    ...overrides,
  } as InvoiceItem;
}

const SETTINGS: SellerSettings = {
  currency: 'EUR',
  businessName: 'Padaria do Bairro',
  businessAddress: 'Av. Central 5',
  businessTaxId: 'PT500500500',
  businessEmail: 'hello@padaria.pt',
  businessLogoUrl: 'https://cdn.example.com/logo.png',
};

describe('buildInvoiceDocumentData', () => {
  it('computes each line and reconciles with the frozen totals', () => {
    const items = [
      makeItem({ id: 'a', quantity: '10', unitPriceCents: 350, taxRate: '23' }),
      makeItem({ id: 'b', quantity: '2.5', unitPriceCents: 800, taxRate: '6' }),
    ];
    const lineInputs = items.map((it) => ({
      quantity: Number(it.quantity),
      unitPriceCents: it.unitPriceCents,
      taxRate: Number(it.taxRate),
    }));
    const frozen = invoiceTotals(lineInputs);
    const invoice = makeInvoice(frozen);

    const data = buildInvoiceDocumentData({ invoice, items }, SETTINGS, 'Clerk Org');

    // Each rendered line gross matches the shared line math.
    data.lines.forEach((line, i) => {
      expect(line.grossCents).toBe(lineTotals(lineInputs[i]!).grossCents);
    });
    // Sum of rendered line gross == frozen total (no penny drift).
    const sumGross = data.lines.reduce((s, l) => s + l.grossCents, 0);
    expect(sumGross).toBe(frozen.totalCents);
    // Frozen subtotal/tax/total used verbatim.
    expect(data.subtotalCents).toBe(frozen.subtotalCents);
    expect(data.taxCents).toBe(frozen.taxCents);
    expect(data.totalCents).toBe(frozen.totalCents);
  });

  it('uses frozen totals verbatim even if they disagree with the lines', () => {
    // Defensive: the document must reproduce the stored invoice, never recompute.
    const invoice = makeInvoice({ subtotalCents: 999, taxCents: 1, totalCents: 1000 });
    const data = buildInvoiceDocumentData(
      { invoice, items: [makeItem()] },
      SETTINGS,
      null,
    );
    expect(data.totalCents).toBe(1000);
  });

  it('prefers businessName, falling back to the org name then empty', () => {
    const withName = buildInvoiceDocumentData(
      { invoice: makeInvoice(), items: [] },
      SETTINGS,
      'Clerk Org',
    );
    expect(withName.seller.name).toBe('Padaria do Bairro');

    const noBusinessName = buildInvoiceDocumentData(
      { invoice: makeInvoice(), items: [] },
      { ...SETTINGS, businessName: null },
      'Clerk Org',
    );
    expect(noBusinessName.seller.name).toBe('Clerk Org');

    const nothing = buildInvoiceDocumentData(
      { invoice: makeInvoice(), items: [] },
      { ...SETTINGS, businessName: '   ' },
      null,
    );
    expect(nothing.seller.name).toBe('');
  });

  it('collapses blank seller/customer fields to null', () => {
    const data = buildInvoiceDocumentData(
      {
        invoice: makeInvoice({ customerTaxId: '   ', customerAddress: '', notes: ' ' }),
        items: [],
      },
      { ...SETTINGS, businessAddress: '  ', businessEmail: '' },
      'Org',
    );
    expect(data.customer.taxId).toBeNull();
    expect(data.customer.address).toBeNull();
    expect(data.notes).toBeNull();
    expect(data.seller.address).toBeNull();
    expect(data.seller.email).toBeNull();
  });

  it('passes through the draft (null) invoice number and status', () => {
    const data = buildInvoiceDocumentData(
      { invoice: makeInvoice({ number: null, status: 'draft' }), items: [] },
      SETTINGS,
      'Org',
    );
    expect(data.number).toBeNull();
    expect(data.status).toBe('draft');
  });
});

describe('invoiceDocumentFilename', () => {
  it('uses the invoice number when issued', () => {
    expect(invoiceDocumentFilename({ id: 'x', number: 'INV-2026-0001' })).toBe(
      'INV-2026-0001',
    );
  });

  it('falls back to a stable draft-<id> stem and sanitizes', () => {
    expect(invoiceDocumentFilename({ id: 'abc/def', number: null })).toBe(
      'draft-abc_def',
    );
  });
});
