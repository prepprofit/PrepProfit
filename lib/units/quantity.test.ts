import { describe, expect, it } from 'vitest';
import { parseQuantityText } from './quantity';

/** Assert a written quantity parses to (approximately) `value`. */
function val(raw: string): number {
  const r = parseQuantityText(raw);
  if ('error' in r) throw new Error(`expected a value for ${JSON.stringify(raw)}`);
  return r.value;
}

describe('parseQuantityText — integers & decimals', () => {
  it('parses plain integers and decimals', () => {
    expect(val('3')).toBe(3);
    expect(val('0.5')).toBe(0.5);
    expect(val('1.25')).toBe(1.25);
  });

  it('accepts a comma decimal separator', () => {
    expect(val('2,5')).toBe(2.5);
  });
});

describe('parseQuantityText — ASCII fractions', () => {
  it('parses a simple fraction', () => {
    expect(val('1/2')).toBe(0.5);
    expect(val('3/4')).toBe(0.75);
  });

  it('parses a mixed number', () => {
    expect(val('1 1/2')).toBe(1.5);
    expect(val('2 3/4')).toBe(2.75);
  });
});

describe('parseQuantityText — Unicode vulgar fractions', () => {
  it('parses a lone vulgar fraction', () => {
    expect(val('½')).toBe(0.5);
    expect(val('¼')).toBe(0.25);
    expect(val('¾')).toBe(0.75);
    expect(val('⅓')).toBeCloseTo(1 / 3, 10);
  });

  it('parses a whole number fused with a vulgar fraction', () => {
    expect(val('1½')).toBe(1.5);
    expect(val('1 ½')).toBe(1.5);
    expect(val('2¾')).toBe(2.75);
  });
});

describe('parseQuantityText — rejects unparseable / non-positive', () => {
  it('rejects blank, zero, negatives, and prose', () => {
    for (const raw of ['', '   ', '0', '-1', 'a pinch', '1/0', './5', '1/2/3']) {
      expect(parseQuantityText(raw)).toEqual({ error: 'INVALID_NUMBER' });
    }
  });
});
