import { describe, expect, it } from 'vitest';
import {
  canonicalToField,
  canonicalToUnitAmount,
  fieldToCanonical,
  lineDisplayUnit,
  parseDecimal,
  parseMoneyText,
  parsePercentBps,
} from './dish-editor';
import { ingredientCanonicalQuantity } from '@/lib/calculations/dish';

describe('dish editor quantities', () => {
  it('shows 15,000 g as 15 kg and back, without drift', () => {
    expect(canonicalToField(15_000, 'kg')).toBe('15');
    expect(canonicalToField(15_000, 'g')).toBe('15000');
    expect(fieldToCanonical('15', 'kg')).toBe(15_000);
  });

  it('switching g/kg repeatedly preserves every stored quantity', () => {
    for (const grams of [0.0001, 1, 12.3456, 250, 999.9999, 15_000, 1_234_567.8912]) {
      let text = canonicalToField(grams, 'g');
      for (let flip = 0; flip < 10; flip++) {
        const unit = flip % 2 === 0 ? 'kg' : 'g';
        // Re-read what is shown in one unit, render it in the other — as the switch does.
        const canonical = fieldToCanonical(text, flip % 2 === 0 ? 'g' : 'kg');
        expect(canonical).toBe(grams);
        text = canonicalToField(canonical as number, unit);
      }
    }
  });

  it('accepts decimal commas and points, rejects the unreadable', () => {
    expect(parseDecimal('1,5')).toBe(1.5);
    expect(parseDecimal('1.5')).toBe(1.5);
    expect(parseDecimal(',5')).toBe(0.5);
    expect(parseDecimal('15 000')).toBe(15_000);
    expect(parseDecimal('')).toBeNull();
    expect(parseDecimal('-2')).toBeNull();
    expect(parseDecimal('1.2.3')).toBeNull();
    expect(parseDecimal('1,2,3')).toBeNull();
    expect(parseDecimal('abc')).toBeNull();
    expect(fieldToCanonical('0,25', 'kg')).toBe(250);
    expect(fieldToCanonical('2,5', 'g')).toBe(2.5);
  });

  it('rounds to the stored 4 decimals', () => {
    expect(fieldToCanonical('0.00012345', 'kg')).toBe(0.1235);
    expect(fieldToCanonical('1.23456', 'g')).toBe(1.2346);
  });

  it('keeps pieces as pieces and ml/l as volume — never treated as weight', () => {
    expect(lineDisplayUnit('count', 'piece', 'kg')).toBe('piece');
    expect(lineDisplayUnit('volume', 'l', 'g')).toBe('l');
    expect(lineDisplayUnit('volume', 'ml', 'kg')).toBe('ml');
    expect(lineDisplayUnit('volume', null, 'kg')).toBe('ml');
    expect(lineDisplayUnit('weight', 'kg', 'g')).toBe('g');
    expect(lineDisplayUnit('weight', 'g', 'kg')).toBe('kg');
    expect(fieldToCanonical('3', 'piece')).toBe(3);
    expect(canonicalToField(1_500, 'l')).toBe('1.5');
  });

  it('sends an amount the server converts back to the same canonical quantity', () => {
    for (const [canonical, unit] of [
      [12.3456, 'kg'],
      [15_000, 'kg'],
      [250, 'g'],
      [1_500, 'l'],
      [3, 'piece'],
    ] as const) {
      const sent = canonicalToUnitAmount(canonical, unit);
      // The column is numeric(12,4): what the server stores rounds to 4 decimals.
      expect(Math.round(ingredientCanonicalQuantity(sent, unit) * 10_000) / 10_000).toBe(canonical);
    }
  });
});

describe('dish editor money and percentages', () => {
  it('parses prices with either decimal convention', () => {
    expect(parseMoneyText('3')).toBe(300);
    expect(parseMoneyText('3,5')).toBe(350);
    expect(parseMoneyText('2.04')).toBe(204);
    expect(parseMoneyText('1.234,56')).toBe(123_456);
    expect(parseMoneyText('1,234.56')).toBe(123_456);
    expect(parseMoneyText('€ 20')).toBe(2_000);
    expect(parseMoneyText('')).toBeNull();
    expect(parseMoneyText('-3')).toBeNaN();
    expect(parseMoneyText('1.2.3')).toBeNaN();
    expect(parseMoneyText('abc')).toBeNaN();
  });

  it('parses VAT and target percentages to basis points', () => {
    expect(parsePercentBps('13,5')).toBe(1_350);
    expect(parsePercentBps('70')).toBe(7_000);
    expect(parsePercentBps('99.99')).toBe(9_999);
    expect(parsePercentBps('')).toBeNull();
    expect(parsePercentBps('-5')).toBeNull();
  });
});
