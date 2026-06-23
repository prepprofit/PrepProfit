import { toCsv, neutralizeFormula } from '@/lib/finance/csv';
import { renderXlsx, headerCell, textCell, type Sheet } from '@/lib/documents/xlsx';
import {
  INGREDIENT_COLUMNS,
  TRANSACTION_COLUMNS,
  RECIPE_COLUMNS,
  SALES_COLUMNS,
} from '@/lib/validation/import';
import type { FileImportEntity, FileImportFormat } from './types';

/**
 * Import TEMPLATE generation (Sprint 4.5). The downloadable starter files whose
 * columns EXACTLY match what `lib/import/parse.ts` expects (and, for transactions,
 * the CSV export in `lib/finance/csv.ts`) — so a user can fill a template and
 * re-import it cleanly. Example rows are illustrative and deliberately contain no
 * formula-trigger characters; the XLSX writer still neutralizes text cells.
 */

const COLUMNS: Record<FileImportEntity, readonly string[]> = {
  ingredients: INGREDIENT_COLUMNS,
  transactions: TRANSACTION_COLUMNS,
  recipes: RECIPE_COLUMNS,
  sales: SALES_COLUMNS,
};

/** Illustrative example rows (cells aligned to each entity's column order). */
const EXAMPLES: Record<FileImportEntity, string[][]> = {
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
  // Long format: one row per ingredient line, grouped by the recipe name. Yield
  // columns are read from each recipe's FIRST row (leave blank on later lines).
  recipes: [
    ['Sourdough Bread', '10', '95', 'Flour T55', '1000', 'g'],
    ['Sourdough Bread', '', '', 'Water', '650', 'ml'],
    ['Sourdough Bread', '', '', 'Salt', '18', 'g'],
    ['Tomato Sauce', '4', '100', 'Tomato', '800', 'g'],
    ['Tomato Sauce', '', '', 'Olive oil', '30', 'ml'],
    ['Tomato Sauce', '', '', 'Eggs', '2', 'count'],
  ],
  // Long format: one row per sale-item line, grouped into a daily close by the date.
  // unit_net_price is the EXCLUSIVE net price per sold unit; tax_rate_percent is
  // optional (blank uses the org default). ingredient_qty_canonical is required only
  // for an ingredient line (canonical stock per sold unit), blank for recipe/menu.
  sales: [
    ['2026-06-01', 'recipe', 'Sourdough Bread', '12', '4.50', '23', ''],
    ['2026-06-01', 'menu', 'Lunch Combo', '8', '12.00', '23', ''],
    ['2026-06-01', 'ingredient', 'Bottled Water', '20', '1.50', '23', '500'],
  ],
};

/** Build the CSV template bytes for an entity. */
export function buildCsvTemplate(entity: FileImportEntity): string {
  return toCsv([...COLUMNS[entity]], EXAMPLES[entity]);
}

/** Build the XLSX template bytes for an entity (Node runtime). */
export function buildXlsxTemplate(entity: FileImportEntity): Promise<Buffer> {
  const header = COLUMNS[entity].map((c) => headerCell(c));
  const body = EXAMPLES[entity].map((row) => row.map((v) => textCell(v)));
  const sheet: Sheet = { name: entity, rows: [header, ...body] };
  return renderXlsx([sheet]);
}

/** The download filename for a template, e.g. `ingredients-import-template.csv`. */
export function templateFilename(
  entity: FileImportEntity,
  format: FileImportFormat,
): string {
  // Entity + format are validated enums; neutralize defensively anyway.
  return neutralizeFormula(`${entity}-import-template.${format}`);
}
