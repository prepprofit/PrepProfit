import { describe, expect, it } from 'vitest';
import { buildPayrollSheetRows, renderPayrollXlsx } from './payroll-xlsx';
import { buildPayrollLabels } from './payroll-labels';
import type { Cell } from './xlsx';
import type { PayrollDocumentData } from './types';

const labels = buildPayrollLabels((k) => k);

const data: PayrollDocumentData = {
  seller: { name: 'Padaria', address: null, taxId: null, email: null, logoUrl: null },
  periodLabel: 'June 2026',
  view: 'month',
  rows: [
    { name: 'Ana', shiftCount: 5, workedMinutes: 480, payDueCents: 9600 },
    // A name crafted to look like a spreadsheet formula.
    { name: '=HYPERLINK("x")', shiftCount: 1, workedMinutes: 90, payDueCents: 1800 },
  ],
  totalShiftCount: 6,
  totalWorkedMinutes: 570,
  totalPayCents: 11400,
  currency: 'EUR',
};

function findRow(rows: Cell[][], firstValue: string): Cell[] | undefined {
  return rows.find((r) => {
    const c = r[0];
    return c && 'value' in c && c.value === firstValue;
  });
}

describe('buildPayrollSheetRows', () => {
  it('writes hours as decimal Numbers and pay as money Numbers', () => {
    const rows = buildPayrollSheetRows(data, labels);
    const ana = findRow(rows, 'Ana')!;
    expect(ana[2]).toMatchObject({ value: 8, type: Number }); // 480 / 60
    expect(ana[3]).toMatchObject({ value: 96, type: Number }); // 9600 / 100
  });

  it('neutralizes a formula-like employee name', () => {
    const rows = buildPayrollSheetRows(data, labels);
    expect(findRow(rows, '\'=HYPERLINK("x")')).toBeDefined();
  });

  it('appends a totals row', () => {
    const rows = buildPayrollSheetRows(data, labels);
    const total = findRow(rows, labels.total)!;
    expect(total[1]).toMatchObject({ value: 6, type: Number });
    expect(total[3]).toMatchObject({ value: 114, type: Number }); // 11400 / 100
  });
});

describe('renderPayrollXlsx', () => {
  it('returns a valid .xlsx (ZIP) buffer', async () => {
    const buffer = await renderPayrollXlsx(data, labels);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });
});
