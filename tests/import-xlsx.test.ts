import { describe, expect, it } from 'vitest';
import writeXlsxFile from 'write-excel-file/node';
import { parseXlsx } from '@/lib/import/xlsx';

/**
 * Round-trips a workbook through the writer we use for exports and the reader the
 * import uses, proving cells normalize to strings and that a formula-looking text
 * cell is read back as a LITERAL string (never evaluated).
 */
async function buildXlsx(
  rows: { value: string | number | Date | null; type?: unknown; format?: string }[][],
) {
  return (await writeXlsxFile(rows as never, { buffer: true })) as Buffer;
}

describe('parseXlsx — reader seam', () => {
  it('reads cells back as trimmed strings', async () => {
    const buf = await buildXlsx([
      [
        { value: 'name', type: String },
        { value: 'price', type: String },
      ],
      [
        { value: 'Flour', type: String },
        { value: 1.2, type: Number },
      ],
    ]);
    expect(await parseXlsx(buf)).toEqual([
      ['name', 'price'],
      ['Flour', '1.2'],
    ]);
  });

  it('reads a formula-looking text cell as a LITERAL string', async () => {
    const buf = await buildXlsx([
      [{ value: 'note', type: String }],
      [{ value: '=1+2', type: String }],
    ]);
    const rows = await parseXlsx(buf);
    expect(rows[1]?.[0]).toBe('=1+2');
  });

  it('normalizes a real date cell to YYYY-MM-DD', async () => {
    const buf = await buildXlsx([
      [{ value: 'date', type: String }],
      [{ value: new Date(Date.UTC(2026, 5, 15)), type: Date, format: 'yyyy-mm-dd' }],
    ]);
    const rows = await parseXlsx(buf);
    expect(rows[1]?.[0]).toBe('2026-06-15');
  });
});
