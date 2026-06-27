import { describe, expect, it } from 'vitest';
import { parseUnitToken } from './token';
import { dimensionOf, type Unit } from './index';

/** Resolve a token to its unit or throw (keeps assertions terse). */
function unit(raw: string): Unit {
  const r = parseUnitToken(raw);
  if ('error' in r) throw new Error(`expected a unit for ${JSON.stringify(raw)}`);
  return r.unit;
}

describe('parseUnitToken — canonical tokens & blank', () => {
  it('accepts each canonical token verbatim', () => {
    for (const u of ['g', 'kg', 'oz', 'lb', 'ml', 'l', 'floz', 'cup', 'tsp', 'tbsp', 'count'] as const) {
      expect(unit(u)).toBe(u);
    }
  });

  it('treats a blank token as count', () => {
    expect(unit('')).toBe('count');
    expect(unit('   ')).toBe('count');
  });
});

describe('parseUnitToken — true cooking volumes (RC-1)', () => {
  it('resolves teaspoon/tablespoon aliases to volume units', () => {
    expect(unit('teaspoon')).toBe('tsp');
    expect(unit('teaspoons')).toBe('tsp');
    expect(unit('Tbsp')).toBe('tbsp');
    expect(unit('Tablespoons')).toBe('tbsp');
    expect(unit('table spoon')).toBe('tbsp'); // whitespace-stripped before lookup
    expect(dimensionOf(unit('tsp'))).toBe('volume');
    expect(dimensionOf(unit('tbsp'))).toBe('volume');
  });
});

describe('parseUnitToken — unknown tokens', () => {
  it('returns INVALID_UNIT for descriptor/prose tokens', () => {
    for (const raw of ['handful', 'pinch', 'smidgen', 'glug']) {
      expect(parseUnitToken(raw)).toEqual({ error: 'INVALID_UNIT' });
    }
  });
});
