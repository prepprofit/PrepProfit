import { describe, expect, it } from 'vitest';
import { renderPayrollPdf } from './payroll-pdf';
import { buildPayrollLabels } from './payroll-labels';
import type { PayrollDocumentData } from './types';

/** Smoke test: the payroll summary renderer produces real, non-empty PDF bytes. */
const labels = buildPayrollLabels((k) => k);

const data: PayrollDocumentData = {
  seller: { name: 'Padaria', address: null, taxId: null, email: null, logoUrl: null },
  periodLabel: 'June 2026',
  view: 'month',
  rows: [
    { name: 'Ana', shiftCount: 5, workedMinutes: 2400, payDueCents: 48000 },
    { name: 'Beto', shiftCount: 3, workedMinutes: 1440, payDueCents: 36000 },
  ],
  totalShiftCount: 8,
  totalWorkedMinutes: 3840,
  totalPayCents: 84000,
  currency: 'EUR',
};

describe('renderPayrollPdf', () => {
  it('returns non-empty PDF bytes', async () => {
    const buffer = await renderPayrollPdf(data, labels);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });

  it('renders an empty period without throwing', async () => {
    const buffer = await renderPayrollPdf(
      { ...data, rows: [], totalShiftCount: 0, totalWorkedMinutes: 0, totalPayCents: 0 },
      labels,
    );
    expect(buffer.length).toBeGreaterThan(0);
  });
});
