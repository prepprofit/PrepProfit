import { describe, expect, it } from 'vitest';
import { renderInvoicePdf } from './invoice-pdf';
import { buildInvoiceLabels } from './invoice-labels';
import type { InvoiceDocumentData } from './types';

/**
 * Smoke test: the invoice PDF renderer produces real, non-empty PDF bytes. Uses an
 * identity translator for labels so the test stays locale-agnostic.
 */
const labels = buildInvoiceLabels((k) => k);

const data: InvoiceDocumentData = {
  seller: {
    name: 'Padaria do Bairro',
    address: 'Av. Central 5',
    taxId: 'PT500500500',
    email: 'hello@padaria.pt',
    logoUrl: null, // no remote fetch in the smoke test
  },
  customer: {
    name: 'Café Lisboa',
    taxId: 'PT123456789',
    address: 'Rua das Flores 1',
    email: null,
  },
  number: 'INV-2026-0001',
  status: 'issued',
  issueDate: '2026-06-18',
  dueDate: '2026-07-18',
  notes: 'Thank you',
  currency: 'EUR',
  lines: [
    {
      description: 'Sourdough loaf',
      quantity: 10,
      unitPriceCents: 350,
      taxRatePercent: 23,
      netCents: 3500,
      taxCents: 805,
      grossCents: 4305,
    },
  ],
  subtotalCents: 3500,
  taxCents: 805,
  totalCents: 4305,
};

describe('renderInvoicePdf', () => {
  it('returns non-empty PDF bytes', async () => {
    const buffer = await renderInvoicePdf(data, labels);
    expect(buffer.length).toBeGreaterThan(0);
    // A valid PDF starts with the "%PDF" magic header.
    expect(buffer.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });

  it('renders a draft watermark without throwing', async () => {
    const buffer = await renderInvoicePdf(
      { ...data, status: 'draft', number: null },
      labels,
    );
    expect(buffer.length).toBeGreaterThan(0);
  });
});
