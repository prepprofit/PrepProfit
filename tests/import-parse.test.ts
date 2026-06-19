import { describe, expect, it } from 'vitest';
import { parseCsv } from '@/lib/import/csv';
import { parseIngredients, parseTransactions } from '@/lib/import/parse';
import { MAX_IMPORT_ROWS } from '@/lib/validation/import';

/** Parse a CSV string straight into the entity parser. */
const ing = (csv: string) => parseIngredients(parseCsv(csv));
const txn = (csv: string) => parseTransactions(parseCsv(csv));

/** Collect the issue codes for a given 1-based line. */
function codesAt(
  result: ReturnType<typeof ing> | ReturnType<typeof txn>,
  line: number,
): string[] {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result.rows
    .flatMap((r) => r.issues)
    .filter((i) => i.line === line)
    .map((i) => i.code);
}

describe('parseIngredients', () => {
  it('parses a clean row into a draft', () => {
    const r = ing('name,dimension,price,supplier\nFlour,weight,1.20,ACME');
    if (!r.ok) throw new Error(r.error);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.draft).toEqual({
      name: 'Flour',
      dimension: 'weight',
      priceCents: 120,
      supplier: 'ACME',
      needsPricing: false,
    });
  });

  it('flags a blank price as needs-pricing but keeps the row importable', () => {
    const r = ing('name,dimension,price\nSalt,weight,');
    if (!r.ok) throw new Error(r.error);
    expect(r.rows[0]!.draft).toMatchObject({ priceCents: 0, needsPricing: true });
    expect(codesAt(r, 2)).toEqual(['NEEDS_PRICING']);
  });

  it('rejects a row missing required fields (draft null)', () => {
    const r = ing('name,dimension\n,weight');
    if (!r.ok) throw new Error(r.error);
    expect(r.rows[0]!.draft).toBeNull();
    expect(codesAt(r, 2)).toContain('MISSING_REQUIRED');
  });

  it('flags an invalid dimension and an invalid price', () => {
    const r = ing('name,dimension,price\nFlour,grams,abc');
    expect(codesAt(r, 2)).toEqual(
      expect.arrayContaining(['INVALID_DIMENSION', 'INVALID_NUMBER']),
    );
  });

  it('flags a negative price', () => {
    const r = ing('name,dimension,price\nFlour,weight,-5');
    expect(codesAt(r, 2)).toContain('NEGATIVE_AMOUNT');
  });

  it('rejects unknown columns at the file level', () => {
    const r = ing('name,dimension,colour\nFlour,weight,white');
    expect(r).toEqual({ ok: false, error: 'UNKNOWN_COLUMNS' });
  });

  it('rejects a file missing a required column', () => {
    const r = ing('name,price\nFlour,1.20');
    expect(r).toEqual({ ok: false, error: 'MISSING_COLUMNS' });
  });

  it('skips fully blank rows and preserves spreadsheet line numbers', () => {
    const r = ing('name,dimension\nFlour,weight\n\nSugar,weight');
    if (!r.ok) throw new Error(r.error);
    expect(r.rows.map((x) => x.line)).toEqual([2, 4]);
  });

  it('rejects a file with more than the row cap', () => {
    const body = Array.from(
      { length: MAX_IMPORT_ROWS + 1 },
      (_, i) => `Item${i},weight`,
    ).join('\n');
    const r = ing(`name,dimension\n${body}`);
    expect(r).toEqual({ ok: false, error: 'TOO_MANY_ROWS' });
  });
});

describe('parseTransactions', () => {
  it('parses a clean row into a draft (category stays a name)', () => {
    const r = txn('date,type,category,amount\n2026-06-15,income,Sales,12.34');
    if (!r.ok) throw new Error(r.error);
    expect(r.rows[0]!.draft).toEqual({
      type: 'income',
      categoryName: 'Sales',
      occurredOn: '2026-06-15',
      amountCents: 1234,
      note: null,
    });
  });

  it('accepts the app export columns (recipe accepted, not linked)', () => {
    const r = txn(
      'date,type,category,recipe,amount,note\n2026-06-15,expense,Supplies,Bread,9.99,memo',
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.rows[0]!.draft).toMatchObject({ amountCents: 999, note: 'memo' });
  });

  it('flags an impossible date and a bad type', () => {
    const r = txn('date,type,category,amount\n2026-13-40,buy,Sales,5');
    expect(codesAt(r, 2)).toEqual(
      expect.arrayContaining(['INVALID_DATE', 'INVALID_TYPE']),
    );
  });

  it('flags a zero/negative amount', () => {
    const r = txn('date,type,category,amount\n2026-06-15,income,Sales,0');
    expect(codesAt(r, 2)).toContain('NEGATIVE_AMOUNT');
  });

  it('keeps a formula-looking note as a literal string (never evaluated)', () => {
    const r = txn(
      'date,type,category,amount,note\n2026-06-15,income,Sales,5,"=1+2"',
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.rows[0]!.draft?.note).toBe('=1+2');
  });

  it('parses comma-decimal money (locale tolerance)', () => {
    const r = txn('date,type,category,amount\n2026-06-15,income,Sales,"1.234,56"');
    if (!r.ok) throw new Error(r.error);
    expect(r.rows[0]!.draft?.amountCents).toBe(123456);
  });
});
