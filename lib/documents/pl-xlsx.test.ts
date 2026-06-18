import { describe, expect, it } from 'vitest';
import { buildPlSheetRows, renderPlXlsx } from './pl-xlsx';
import { buildPlLabels } from './pl-labels';
import type { Cell } from './xlsx';
import type { PlDocumentData } from './types';

const labels = buildPlLabels((k) => k);

const data: PlDocumentData = {
  seller: { name: 'Padaria', address: null, taxId: null, email: null, logoUrl: null },
  periodLabel: 'June 2026',
  view: 'month',
  incomeCents: 15000,
  expenseCents: 5000,
  profitCents: 10000,
  byCategory: [
    { name: 'Food sales', kind: 'income', totalCents: 15000 },
    // A category name crafted to look like a spreadsheet formula.
    { name: '=SUM(A1:A9)', kind: 'expense', totalCents: 5000 },
  ],
  topProducts: [{ name: '+Bread', totalCents: 15000 }],
  monthly: null,
  currency: 'EUR',
};

/** Find the row whose first text cell equals `value`. */
function findRow(rows: Cell[][], firstValue: string): Cell[] | undefined {
  return rows.find((r) => {
    const c = r[0];
    return c && 'value' in c && c.value === firstValue;
  });
}

describe('buildPlSheetRows', () => {
  it('writes money as real Numbers (cents / 100)', () => {
    const rows = buildPlSheetRows(data, labels);
    // Summary value row: income / expense / profit.
    const summary = rows.find(
      (r) => r.length === 3 && r[0] && 'type' in r[0] && r[0].type === Number,
    )!;
    expect(summary[0]).toMatchObject({ value: 150, type: Number });
    expect(summary[2]).toMatchObject({ value: 100, type: Number });
  });

  it('neutralizes formula-like text cells (category + product names)', () => {
    const rows = buildPlSheetRows(data, labels);
    const catRow = findRow(rows, "'=SUM(A1:A9)");
    expect(catRow).toBeDefined();
    const prodRow = findRow(rows, "'+Bread");
    expect(prodRow).toBeDefined();
  });

  it('renders monthly rows only in the year view', () => {
    const monthRows = buildPlSheetRows(data, labels);
    expect(findRow(monthRows, labels.monthly)).toBeUndefined();

    const monthly = Array.from({ length: 12 }, (_, i) => ({
      label: `M${i + 1}`,
      incomeCents: 0,
      expenseCents: 0,
      profitCents: 0,
    }));
    const yearRows = buildPlSheetRows({ ...data, view: 'year', monthly }, labels);
    expect(findRow(yearRows, labels.monthly)).toBeDefined();
  });
});

describe('renderPlXlsx', () => {
  it('returns a valid .xlsx (ZIP) buffer', async () => {
    const buffer = await renderPlXlsx(data, labels);
    expect(buffer.length).toBeGreaterThan(0);
    // .xlsx is a ZIP container — first bytes are the local-file-header magic.
    expect(buffer.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });
});
