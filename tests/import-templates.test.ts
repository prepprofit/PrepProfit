import { describe, expect, it } from 'vitest';
import {
  buildCsvTemplate,
  buildXlsxTemplate,
  templateFilename,
} from '@/lib/import/templates';
import { parseCsv } from '@/lib/import/csv';
import { parseXlsx } from '@/lib/import/xlsx';
import { parseIngredients, parseTransactions, parseRecipes } from '@/lib/import/parse';

describe('import templates round-trip through the parser', () => {
  it('the ingredients CSV template parses with every example row importable', () => {
    const result = parseIngredients(parseCsv(buildCsvTemplate('ingredients')));
    if (!result.ok) throw new Error(result.error);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every((r) => r.draft !== null)).toBe(true);
  });

  it('the transactions CSV template parses with every example row importable', () => {
    const result = parseTransactions(parseCsv(buildCsvTemplate('transactions')));
    if (!result.ok) throw new Error(result.error);
    expect(result.rows.every((r) => r.draft !== null)).toBe(true);
  });

  it('the ingredients XLSX template parses cleanly', async () => {
    const buffer = await buildXlsxTemplate('ingredients');
    const result = parseIngredients(await parseXlsx(buffer));
    if (!result.ok) throw new Error(result.error);
    expect(result.rows.every((r) => r.draft !== null)).toBe(true);
  });

  it('the recipes CSV template parses into grouped recipes with valid lines', () => {
    const result = parseRecipes(parseCsv(buildCsvTemplate('recipes')));
    if (!result.ok) throw new Error(result.error);
    expect(result.recipes.length).toBe(2);
    expect(result.recipes.every((r) => r.lines.length > 0)).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('the recipes XLSX template parses cleanly', async () => {
    const buffer = await buildXlsxTemplate('recipes');
    const result = parseRecipes(await parseXlsx(buffer));
    if (!result.ok) throw new Error(result.error);
    expect(result.recipes.length).toBe(2);
    expect(result.issues).toHaveLength(0);
  });

  it('builds a safe, predictable filename', () => {
    expect(templateFilename('transactions', 'xlsx')).toBe(
      'transactions-import-template.xlsx',
    );
  });
});
