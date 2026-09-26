import { describe, expect, it } from 'vitest';
import {
  displayNumberToGrams,
  formatWeightForUnit,
  gramsToDisplayNumber,
  parseWeightInput,
} from './weight';

describe('formatWeightForUnit', () => {
  it('converts whole kilograms without trailing zeros', () => {
    expect(formatWeightForUnit(1000, 'kg')).toBe('1');
  });

  it('preserves precision for sub-kilogram amounts', () => {
    expect(formatWeightForUnit(165, 'kg')).toBe('0.165');
  });

  it('never zeroes out very small quantities', () => {
    expect(formatWeightForUnit(2, 'kg')).toBe('0.002');
  });

  it('formats grams with at most 2 decimals, trimmed', () => {
    expect(formatWeightForUnit(250, 'g')).toBe('250');
    expect(formatWeightForUnit(0.5, 'g')).toBe('0.5');
  });

  it('never shows a bare "-0"', () => {
    expect(formatWeightForUnit(0, 'kg')).toBe('0');
    expect(formatWeightForUnit(0, 'g')).toBe('0');
  });
});

describe('gramsToDisplayNumber / displayNumberToGrams', () => {
  it('round-trips without drift across repeated unit switches', () => {
    let grams = 165;
    for (let i = 0; i < 20; i++) {
      const kg = gramsToDisplayNumber(grams, 'kg');
      grams = displayNumberToGrams(kg, 'kg');
    }
    expect(grams).toBeCloseTo(165, 9);
  });

  it('g is the identity conversion', () => {
    expect(gramsToDisplayNumber(500, 'g')).toBe(500);
    expect(displayNumberToGrams(500, 'g')).toBe(500);
  });
});

describe('parseWeightInput', () => {
  it('accepts decimal commas and dots', () => {
    expect(parseWeightInput('0,165', 'kg')).toBeCloseTo(165, 9);
    expect(parseWeightInput('0.165', 'kg')).toBeCloseTo(165, 9);
  });

  it('parses a kilogram amount back to canonical grams', () => {
    expect(parseWeightInput('1', 'kg')).toBe(1000);
    expect(parseWeightInput('0.002', 'kg')).toBeCloseTo(2, 9);
  });

  it('rejects invalid text', () => {
    expect(parseWeightInput('', 'g')).toBeNull();
    expect(parseWeightInput('abc', 'kg')).toBeNull();
    expect(parseWeightInput('-5', 'g')).toBeNull();
  });
});
