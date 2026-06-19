import { toCsv, neutralizeFormula } from '@/lib/finance/csv';
import { renderXlsx, headerCell, textCell, type Sheet } from '@/lib/documents/xlsx';
import {
  INGREDIENT_COLUMNS,
  TRANSACTION_COLUMNS,
} from '@/lib/validation/import';
import type { ImportEntity, ImportFormat } from './types';

/**
 * Import TEMPLATE generation (Sprint 4.5). The downloadable starter files whose
 * columns EXACTLY match what `lib/import/parse.ts` expects (and, for transactions,
 * the CSV export in `lib/finance/csv.ts`) — so a user can fill a template and
 * re-import it cleanly. Example rows are illustrative and deliberately contain no
 * formula-trigger characters; the XLSX writer still neutralizes text cells.
 */

const COLUMNS: Record<ImportEntity, readonly string[]> = {
  ingredients: INGREDIENT_COLUMNS,
  transactions: TRANSACTION_COLUMNS,
};

/** Illustrative example rows (cells aligned to each entity's column order). */
const EXAMPLES: Record<ImportEntity, string[][]> = {
  ingredients: [
    ['Flour T55', 'weight', '1.20', 'ACME Foods'],
    ['Olive oil', 'volume', '8.50', ''],
    ['Eggs', 'count', '0.30', 'Local Farm'],
  ],
  transactions: [
    ['2026-06-01', 'income', 'Food sales', '', '1250.00', 'Saturday service'],
    [
      '2026-06-02',
      'expense',
      'Ingredients / Food cost',
      '',
      '340.50',
      'Produce delivery',
    ],
  ],
};

/** Build the CSV template bytes for an entity. */
export function buildCsvTemplate(entity: ImportEntity): string {
  return toCsv([...COLUMNS[entity]], EXAMPLES[entity]);
}

/** Build the XLSX template bytes for an entity (Node runtime). */
export function buildXlsxTemplate(entity: ImportEntity): Promise<Buffer> {
  const header = COLUMNS[entity].map((c) => headerCell(c));
  const body = EXAMPLES[entity].map((row) => row.map((v) => textCell(v)));
  const sheet: Sheet = { name: entity, rows: [header, ...body] };
  return renderXlsx([sheet]);
}

/** The download filename for a template, e.g. `ingredients-import-template.csv`. */
export function templateFilename(
  entity: ImportEntity,
  format: ImportFormat,
): string {
  // Entity + format are validated enums; neutralize defensively anyway.
  return neutralizeFormula(`${entity}-import-template.${format}`);
}
