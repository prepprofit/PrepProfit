import { describe, expect, it } from 'vitest';
import { parseCsv } from '@/lib/import/csv';
import { parseRecipes, type ParseRecipesResult } from '@/lib/import/parse';
import { toCanonical } from '@/lib/units';

/** Parse a CSV string straight into the recipe parser. */
const rec = (csv: string) => parseRecipes(parseCsv(csv));

const HEADER = 'recipe,yield_portions,yield_percentage,ingredient,quantity,unit';

function ok(result: ParseRecipesResult) {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result;
}

/** Issue codes recorded for a given 1-based line. */
function codesAt(result: ParseRecipesResult, line: number): string[] {
  return ok(result)
    .issues.filter((i) => i.line === line)
    .map((i) => i.code);
}

describe('parseRecipes — grouping & yield', () => {
  it('groups lines by recipe and reads yield from the first row', () => {
    const r = ok(
      rec(
        `${HEADER}\n` +
          'Bread,10,95,Flour,1000,g\n' +
          'Bread,,,Water,650,ml\n' +
          'Bread,,,Salt,18,g',
      ),
    );
    expect(r.recipes).toHaveLength(1);
    const bread = r.recipes[0]!;
    expect(bread.name).toBe('Bread');
    expect(bread.yieldPortions).toBe(10);
    expect(bread.yieldPercentage).toBe(95);
    expect(bread.lines).toHaveLength(3);
  });

  it('groups case-insensitively, keeping the first display name', () => {
    const r = ok(rec(`${HEADER}\nBread,2,100,Flour,500,g\nbread,,,Water,300,ml`));
    expect(r.recipes).toHaveLength(1);
    expect(r.recipes[0]!.name).toBe('Bread');
    expect(r.recipes[0]!.lines).toHaveLength(2);
  });

  it('defaults yield to 1 / 100 when blank', () => {
    const r = ok(rec(`${HEADER}\nSauce,,,Tomato,800,g`));
    expect(r.recipes[0]!.yieldPortions).toBe(1);
    expect(r.recipes[0]!.yieldPercentage).toBe(100);
  });

  it('flags an invalid yield but falls back to the default and keeps the line', () => {
    const r = rec(`${HEADER}\nSauce,abc,250,Tomato,800,g`);
    expect(codesAt(r, 2)).toContain('INVALID_NUMBER');
    const sauce = ok(r).recipes[0]!;
    expect(sauce.yieldPortions).toBe(1);
    expect(sauce.yieldPercentage).toBe(100);
    expect(sauce.lines).toHaveLength(1);
  });
});

describe('parseRecipes — units & quantities', () => {
  it('converts each unit to canonical and infers the dimension', () => {
    const r = ok(
      rec(
        `${HEADER}\n` +
          'R,1,100,A,2,kg\n' +
          'R,,,B,1.5,l\n' +
          'R,,,C,3,count\n' +
          'R,,,D,8,oz',
      ),
    );
    const lines = r.recipes[0]!.lines;
    expect(lines[0]).toMatchObject({ quantityCanonical: toCanonical(2, 'kg'), dimension: 'weight' });
    expect(lines[1]).toMatchObject({ quantityCanonical: toCanonical(1.5, 'l'), dimension: 'volume' });
    expect(lines[2]).toMatchObject({ quantityCanonical: 3, dimension: 'count' });
    expect(lines[3]!.dimension).toBe('weight');
  });

  it('treats a blank unit as count', () => {
    const r = ok(rec(`${HEADER}\nR,1,100,Eggs,6,`));
    expect(r.recipes[0]!.lines[0]).toMatchObject({ quantityCanonical: 6, dimension: 'count' });
  });

  it('accepts friendly unit aliases', () => {
    const r = ok(rec(`${HEADER}\nR,1,100,Milk,500,milliliters\nR,,,Flour,1,kilogram`));
    expect(r.recipes[0]!.lines[0]!.dimension).toBe('volume');
    expect(r.recipes[0]!.lines[1]!.quantityCanonical).toBe(toCanonical(1, 'kg'));
  });

  it('rejects an unknown unit as INVALID_UNIT and drops the line', () => {
    const r = rec(`${HEADER}\nR,1,100,Flour,2,spoons`);
    expect(codesAt(r, 2)).toContain('INVALID_UNIT');
    expect(ok(r).recipes[0]!.lines).toHaveLength(0);
  });

  it('rejects a non-numeric or non-positive quantity and drops the line', () => {
    const r = rec(`${HEADER}\nR,1,100,Flour,abc,g\nR,,,Water,0,ml\nR,,,Salt,-5,g`);
    expect(codesAt(r, 2)).toContain('INVALID_NUMBER');
    expect(codesAt(r, 3)).toContain('NEGATIVE_AMOUNT');
    expect(codesAt(r, 4)).toContain('NEGATIVE_AMOUNT');
    expect(ok(r).recipes[0]!.lines).toHaveLength(0);
  });
});

describe('parseRecipes — repeated lines & conflicts', () => {
  it('sums repeated ingredient lines within one recipe (refinement #2)', () => {
    const r = ok(rec(`${HEADER}\nR,1,100,Flour,500,g\nR,,,Flour,250,g`));
    const lines = r.recipes[0]!.lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantityCanonical).toBe(750);
  });

  it('matches repeated lines across casing/accents', () => {
    const r = ok(rec(`${HEADER}\nR,1,100,Açúcar,100,g\nR,,,acucar,50,g`));
    expect(r.recipes[0]!.lines).toHaveLength(1);
    expect(r.recipes[0]!.lines[0]!.quantityCanonical).toBe(150);
  });

  it('flags a dimension conflict for the same ingredient and does not merge', () => {
    const r = rec(`${HEADER}\nR,1,100,Milk,500,ml\nR,,,Milk,200,g`);
    expect(codesAt(r, 3)).toContain('UNIT_MISMATCH');
    const lines = ok(r).recipes[0]!.lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantityCanonical).toBe(500);
  });
});

describe('parseRecipes — required fields & file errors', () => {
  it('flags a missing recipe name and skips the row', () => {
    const r = rec(`${HEADER}\n,1,100,Flour,500,g`);
    expect(codesAt(r, 2)).toContain('MISSING_REQUIRED');
    expect(ok(r).recipes).toHaveLength(0);
  });

  it('flags a missing ingredient name but still registers the recipe', () => {
    const r = rec(`${HEADER}\nR,1,100,,500,g`);
    expect(codesAt(r, 2)).toContain('MISSING_REQUIRED');
    expect(ok(r).recipes[0]!.lines).toHaveLength(0);
  });

  it('rejects an unknown column', () => {
    const r = rec('recipe,ingredient,quantity,unit,bogus\nR,Flour,1,g,x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('UNKNOWN_COLUMNS');
  });

  it('rejects a file missing a required column', () => {
    const r = rec('recipe,ingredient,unit\nR,Flour,g');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('MISSING_COLUMNS');
  });

  it('rejects a file with no data rows', () => {
    const r = rec(HEADER);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('NO_DATA_ROWS');
  });

  it('keeps a formula-injection ingredient name literal (reader-neutralized at write, not evaluated at read)', () => {
    const r = ok(rec(`${HEADER}\nR,1,100,=cmd()|calc,5,g`));
    expect(r.recipes[0]!.lines[0]!.ingredientName).toBe('=cmd()|calc');
  });
});
