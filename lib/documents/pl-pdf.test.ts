import { describe, expect, it } from 'vitest';
import { renderPlPdf } from './pl-pdf';
import { buildPlLabels } from './pl-labels';
import type { PlDocumentData } from './types';

/** Smoke test: the P&L renderer produces real, non-empty PDF bytes. */
const labels = buildPlLabels((k) => k);

const base: PlDocumentData = {
  seller: { name: 'Padaria', address: null, taxId: null, email: null, logoUrl: null },
  periodLabel: 'June 2026',
  view: 'month',
  incomeCents: 15000,
  expenseCents: 5000,
  profitCents: 10000,
  byCategory: [
    { name: 'Food sales', kind: 'income', totalCents: 15000 },
    { name: 'Rent', kind: 'expense', totalCents: 5000 },
  ],
  topProducts: [{ name: 'Bread', totalCents: 15000 }],
  monthly: null,
  currency: 'EUR',
};

describe('renderPlPdf', () => {
  it('returns non-empty PDF bytes (month view)', async () => {
    const buffer = await renderPlPdf(base, labels);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });

  it('renders the year view with monthly rows and a loss', async () => {
    const monthly = Array.from({ length: 12 }, (_, i) => ({
      label: `M${i + 1}`,
      incomeCents: 1000,
      expenseCents: 2000,
      profitCents: -1000,
    }));
    const buffer = await renderPlPdf(
      { ...base, view: 'year', profitCents: -12000, monthly },
      labels,
    );
    expect(buffer.length).toBeGreaterThan(0);
  });
});
