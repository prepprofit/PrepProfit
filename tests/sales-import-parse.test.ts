import { describe, expect, it } from 'vitest';
import { parseSalesRows, normalizeSaleItemName } from '@/lib/import/parse';
import type { DraftSaleImportRow } from '@/lib/import/parse';
import { MAX_IMPORT_ROWS } from '@/lib/validation/import';
import type { ImportIssueCode } from '@/lib/import/types';

/**
 * Pure structural parsing of a sales matrix (Sprint 12b). NO database — item
 * resolution, date dedup, tax defaulting and close grouping are the data-layer
 * planner's job. These cover the column contract, per-cell validation, and the
 * recipe/menu vs ingredient `ingredient_qty_canonical` shape rule.
 */

const HEADER = [
  'date',
  'item_kind',
  'item_name',
  'quantity',
  'unit_net_price',
  'tax_rate_percent',
  'ingredient_qty_canonical',
];

/** All issue codes attached to the row at `index` (0-based among data rows). */
function codesAt(
  result: ReturnType<typeof parseSalesRows>,
  index: number,
): ImportIssueCode[] {
  if (!result.ok) throw new Error(`file error: ${result.error}`);
  return result.rows[index]!.issues.map((i) => i.code);
}

describe('parseSalesRows — valid rows', () => {
  it('parses recipe / menu / ingredient lines with the right fields', () => {
    const matrix = [
      HEADER,
      ['2026-06-01', 'recipe', 'Sourdough', '12', '4.50', '23', ''],
      ['2026-06-01', 'menu', 'Lunch Combo', '8', '12.00', '', ''],
      ['2026-06-01', 'ingredient', 'Bottled Water', '20', '1.50', '23', '500'],
    ];
    const result = parseSalesRows(matrix);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(3);

    const [recipe, menu, ingredient] = result.rows.map((r) => r.draft!) as [
      DraftSaleImportRow,
      DraftSaleImportRow,
      DraftSaleImportRow,
    ];
    expect(recipe).toMatchObject({
      saleDate: '2026-06-01',
      itemKind: 'recipe',
      itemName: 'Sourdough',
      quantity: 12,
      unitNetCents: 450,
      taxRateBps: 2300,
      ingredientQtyCanonical: null,
    });
    // Blank tax percent → null (the planner fills the org default).
    expect(menu.taxRateBps).toBeNull();
    expect(menu.itemKind).toBe('menu');
    expect(ingredient).toMatchObject({
      itemKind: 'ingredient',
      ingredientQtyCanonical: 500,
      taxRateBps: 2300,
    });
    expect(result.rows.every((r) => r.issues.length === 0)).toBe(true);
  });

  it('normalizes the item name key (case + whitespace collapse)', () => {
    expect(normalizeSaleItemName('  Lunch   Combo ')).toBe('lunch combo');
    const matrix = [HEADER, ['2026-06-01', 'recipe', '  Big   Cake ', '1', '5.00', '', '']];
    const result = parseSalesRows(matrix);
    if (!result.ok) return;
    expect(result.rows[0]!.draft!.normalizedItemName).toBe('big cake');
  });
});

describe('parseSalesRows — per-cell validation', () => {
  it('flags a missing / invalid date', () => {
    const matrix = [
      HEADER,
      ['', 'recipe', 'A', '1', '5.00', '', ''],
      ['nope', 'recipe', 'A', '1', '5.00', '', ''],
    ];
    expect(codesAt(parseSalesRows(matrix), 0)).toContain('MISSING_REQUIRED');
    expect(codesAt(parseSalesRows(matrix), 1)).toContain('INVALID_DATE');
  });

  it('flags an unknown item_kind', () => {
    const matrix = [HEADER, ['2026-06-01', 'combo', 'A', '1', '5.00', '', '']];
    expect(codesAt(parseSalesRows(matrix), 0)).toContain('INVALID_TYPE');
  });

  it('flags a bad / missing quantity', () => {
    const matrix = [
      HEADER,
      ['2026-06-01', 'recipe', 'A', '0', '5.00', '', ''],
      ['2026-06-01', 'recipe', 'A', 'x', '5.00', '', ''],
      ['2026-06-01', 'recipe', 'A', '', '5.00', '', ''],
    ];
    expect(codesAt(parseSalesRows(matrix), 0)).toContain('INVALID_NUMBER');
    expect(codesAt(parseSalesRows(matrix), 1)).toContain('INVALID_NUMBER');
    expect(codesAt(parseSalesRows(matrix), 2)).toContain('MISSING_REQUIRED');
  });

  it('flags a bad / missing unit_net_price (0 is allowed)', () => {
    const matrix = [
      HEADER,
      ['2026-06-01', 'recipe', 'A', '1', 'abc', '', ''],
      ['2026-06-01', 'recipe', 'A', '1', '', '', ''],
      ['2026-06-01', 'recipe', 'A', '1', '0', '', ''],
    ];
    expect(codesAt(parseSalesRows(matrix), 0)).toContain('INVALID_NUMBER');
    expect(codesAt(parseSalesRows(matrix), 1)).toContain('MISSING_REQUIRED');
    expect(codesAt(parseSalesRows(matrix), 2)).toHaveLength(0);
  });

  it('flags a tax percent that is non-numeric or out of 0..100', () => {
    const matrix = [
      HEADER,
      ['2026-06-01', 'recipe', 'A', '1', '5.00', 'lots', ''],
      ['2026-06-01', 'recipe', 'A', '1', '5.00', '150', ''],
    ];
    expect(codesAt(parseSalesRows(matrix), 0)).toContain('INVALID_NUMBER');
    expect(codesAt(parseSalesRows(matrix), 1)).toContain('INVALID_NUMBER');
  });

  it('requires ingredient_qty_canonical on an ingredient line', () => {
    const matrix = [HEADER, ['2026-06-01', 'ingredient', 'Water', '1', '1.50', '', '']];
    const codes = codesAt(parseSalesRows(matrix), 0);
    expect(codes).toContain('MISSING_REQUIRED');
  });

  it('rejects ingredient_qty_canonical on a recipe / menu line', () => {
    const matrix = [
      HEADER,
      ['2026-06-01', 'recipe', 'A', '1', '5.00', '', '500'],
      ['2026-06-01', 'menu', 'B', '1', '5.00', '', '500'],
    ];
    expect(codesAt(parseSalesRows(matrix), 0)).toContain('INVALID_NUMBER');
    expect(codesAt(parseSalesRows(matrix), 1)).toContain('INVALID_NUMBER');
  });
});

describe('parseSalesRows — file-level', () => {
  it('rejects missing required columns', () => {
    const matrix = [['date', 'item_kind', 'item_name'], ['2026-06-01', 'recipe', 'A']];
    const result = parseSalesRows(matrix);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('MISSING_COLUMNS');
  });

  it('rejects an unknown column', () => {
    const matrix = [[...HEADER, 'profit'], ['2026-06-01', 'recipe', 'A', '1', '5.00', '', '', '9']];
    const result = parseSalesRows(matrix);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('UNKNOWN_COLUMNS');
  });

  it('rejects a duplicate column', () => {
    const matrix = [[...HEADER, 'date'], ['2026-06-01', 'recipe', 'A', '1', '5.00', '', '', '2026-06-02']];
    const result = parseSalesRows(matrix);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('DUPLICATE_COLUMNS');
  });

  it('rejects too many rows', () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => [
      '2026-06-01',
      'recipe',
      'A',
      '1',
      '5.00',
      '',
      '',
    ]);
    const result = parseSalesRows([HEADER, ...rows]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('TOO_MANY_ROWS');
  });

  it('keeps formula-looking text literal (never evaluated)', () => {
    const matrix = [HEADER, ['2026-06-01', 'recipe', '=SUM(A1:A9)', '1', '5.00', '', '']];
    const result = parseSalesRows(matrix);
    if (!result.ok) return;
    expect(result.rows[0]!.draft!.itemName).toBe('=SUM(A1:A9)');
  });
});
