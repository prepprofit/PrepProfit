import { describe, expect, it } from 'vitest';
import { parseRecipeUnit } from './descriptor';

describe('parseRecipeUnit — canonical units', () => {
  it('resolves true units (incl. tsp/tbsp) to canonical', () => {
    expect(parseRecipeUnit('g')).toEqual({ kind: 'canonical', unit: 'g' });
    expect(parseRecipeUnit('cups')).toEqual({ kind: 'canonical', unit: 'cup' });
    expect(parseRecipeUnit('tbsp')).toEqual({ kind: 'canonical', unit: 'tbsp' });
    expect(parseRecipeUnit('teaspoon')).toEqual({ kind: 'canonical', unit: 'tsp' });
  });

  it('treats a blank token as canonical count (a bare "6 eggs")', () => {
    expect(parseRecipeUnit('')).toEqual({ kind: 'canonical', unit: 'count' });
    expect(parseRecipeUnit('   ')).toEqual({ kind: 'canonical', unit: 'count' });
  });
});

describe('parseRecipeUnit — package descriptors', () => {
  it('classifies pack/count words as descriptors, preserving the display token', () => {
    expect(parseRecipeUnit('pkt')).toEqual({
      kind: 'descriptor',
      descriptor: 'pkt',
      impliedDimension: 'count',
    });
    expect(parseRecipeUnit('Cloves')).toEqual({
      kind: 'descriptor',
      descriptor: 'cloves',
      impliedDimension: 'count',
    });
    for (const token of ['block', 'can', 'bunch', 'sheet', 'stick', 'pinch']) {
      expect(parseRecipeUnit(token).kind).toBe('descriptor');
    }
  });
});

describe('parseRecipeUnit — unknown tokens', () => {
  it('returns INVALID_UNIT for genuinely unknown prose', () => {
    expect(parseRecipeUnit('zorp')).toEqual({ kind: 'unknown', code: 'INVALID_UNIT' });
    expect(parseRecipeUnit('to taste')).toEqual({ kind: 'unknown', code: 'INVALID_UNIT' });
  });
});
