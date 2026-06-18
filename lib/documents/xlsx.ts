import writeXlsxFile from 'write-excel-file/node';
import { neutralizeFormula } from '@/lib/finance/csv';

/**
 * Shared XLSX rendering for report exports (Sprint 3.5B). One thin seam over
 * `write-excel-file` (Node build) so the whole library surface lives in a single
 * file — if it ever stops meeting our needs (multi-sheet, column widths, number
 * formats) the swap to another writer happens only here, with no route/test churn.
 *
 * Document data builders produce `Cell[][]` via the helpers below and hand them to
 * `renderXlsx`, which returns the `.xlsx` bytes (Node runtime only).
 *
 * Money arrives as integer cents (CLAUDE.md) and is written as a real spreadsheet
 * Number (cents / 100) with a 2-decimal format so Excel can sum/filter it. Text
 * cells run through `neutralizeFormula` as defense-in-depth: a string cell is never
 * auto-evaluated by Excel the way a CSV field is, but we still prefix a `'` to any
 * value starting with `= + - @`, a tab, or a CR so a hand-pasted formula can never
 * execute from a downloaded report.
 */

/** A single rendered cell. Mirrors the subset of write-excel-file we use. */
export type Cell =
  | { value: string; type: typeof String; fontWeight?: 'bold' }
  | {
      value: number | null;
      type: typeof Number;
      format?: string;
      fontWeight?: 'bold';
    }
  | { value: null };

/** A column definition (currently just width, in character units). */
export type Column = { width: number };

/** One worksheet: its tab name, the cell grid, and optional column widths. */
export type Sheet = {
  name: string;
  rows: Cell[][];
  columns?: Column[];
};

/** Default money number format — thousands separator, two decimals. */
export const MONEY_FORMAT = '#,##0.00';

/** A bold header cell (always text). */
export function headerCell(value: string): Cell {
  return { value: neutralizeFormula(value), type: String, fontWeight: 'bold' };
}

/** A literal text cell, formula-injection-neutralized. */
export function textCell(value: string | null | undefined): Cell {
  if (value == null || value === '') return { value: null };
  return { value: neutralizeFormula(value), type: String };
}

/** A money cell: integer cents → a real Number (euros) with a 2-decimal format. */
export function moneyCell(cents: number): Cell {
  return { value: cents / 100, type: Number, format: MONEY_FORMAT };
}

/** A plain integer/number cell (counts, hours). */
export function numberCell(value: number, format?: string): Cell {
  return { value, type: Number, format };
}

/** A spacer/empty cell. */
export const emptyCell: Cell = { value: null };

/**
 * Render the given worksheets to `.xlsx` bytes. Node runtime only (imported solely
 * by route handlers). The first sheet is the active one when the file opens.
 */
export async function renderXlsx(sheets: Sheet[]): Promise<Buffer> {
  const data = sheets.map((s) => s.rows);
  const names = sheets.map((s) => s.name);
  const columns = sheets.map((s) => s.columns ?? []);
  const buffer = await writeXlsxFile(data as never, {
    sheets: names,
    columns: columns as never,
    buffer: true,
  });
  return buffer as Buffer;
}
