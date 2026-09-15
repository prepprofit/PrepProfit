import { describe, expect, it } from 'vitest';

import { parseNutrientInput } from './manual-input';

describe('parseNutrientInput', () => {
  it('empty / whitespace is unknown, never zero', () => {
    expect(parseNutrientInput('caloriesKcal', '')).toEqual({ kind: 'empty' });
    expect(parseNutrientInput('caloriesKcal', '   ')).toEqual({ kind: 'empty' });
  });

  it('0 is a deliberate, valid zero', () => {
    expect(parseNutrientInput('sodiumMg', '0')).toEqual({ kind: 'value', value: 0 });
    expect(parseNutrientInput('sodiumMg', '0.0')).toEqual({ kind: 'value', value: 0 });
  });

  it('accepts decimals with a dot or a comma', () => {
    expect(parseNutrientInput('proteinG', '3.25')).toEqual({ kind: 'value', value: 3.25 });
    expect(parseNutrientInput('proteinG', '3,25')).toEqual({ kind: 'value', value: 3.25 });
    expect(parseNutrientInput('proteinG', '.5')).toEqual({ kind: 'value', value: 0.5 });
    expect(parseNutrientInput('proteinG', '12.')).toEqual({ kind: 'value', value: 12 });
  });

  it('rejects negatives, text, exponents, NaN/Infinity words and double separators', () => {
    for (const bad of ['-1', 'abc', '1e3', 'NaN', 'Infinity', '1.2.3', '1,2,3', '12g']) {
      expect(parseNutrientInput('proteinG', bad)).toEqual({ kind: 'invalid' });
    }
  });

  it('enforces the per-nutrient plausibility bound (inclusive)', () => {
    expect(parseNutrientInput('caloriesKcal', '900')).toEqual({ kind: 'value', value: 900 });
    expect(parseNutrientInput('caloriesKcal', '900.1')).toEqual({ kind: 'invalid' });
    expect(parseNutrientInput('totalFatG', '101')).toEqual({ kind: 'invalid' });
    expect(parseNutrientInput('sodiumMg', '38758')).toEqual({ kind: 'value', value: 38758 });
  });
});
