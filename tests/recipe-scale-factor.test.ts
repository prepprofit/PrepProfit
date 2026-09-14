import { describe, expect, it } from 'vitest';
import { formatScaleFactor, parseScaleFactor, roundCanonical } from '@/lib/calculations/recipeScale';

describe('parseScaleFactor (Scale recipe field)', () => {
  it('accepts decimal commas and points with an optional x or ×', () => {
    expect(parseScaleFactor('0,75')).toEqual({ ok: true, factor: 0.75 });
    expect(parseScaleFactor('0.75')).toEqual({ ok: true, factor: 0.75 });
    expect(parseScaleFactor('3')).toEqual({ ok: true, factor: 3 });
    expect(parseScaleFactor('3x')).toEqual({ ok: true, factor: 3 });
    expect(parseScaleFactor(' 1,5 × ')).toEqual({ ok: true, factor: 1.5 });
    expect(parseScaleFactor('2X')).toEqual({ ok: true, factor: 2 });
    expect(parseScaleFactor('1')).toEqual({ ok: true, factor: 1 });
    expect(parseScaleFactor(',5')).toEqual({ ok: true, factor: 0.5 });
  });

  it('rejects zero, negatives, non-finite and text with a reason', () => {
    expect(parseScaleFactor('')).toEqual({ ok: false, reason: 'empty' });
    expect(parseScaleFactor('0')).toEqual({ ok: false, reason: 'notPositive' });
    expect(parseScaleFactor('-2')).toEqual({ ok: false, reason: 'notPositive' });
    expect(parseScaleFactor('Infinity')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseScaleFactor('NaN')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseScaleFactor('1e3')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseScaleFactor('two')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseScaleFactor('1.000,5')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseScaleFactor('1001')).toEqual({ ok: false, reason: 'tooLarge' });
  });

  it('scales quantities from the saved values, never compounding', () => {
    const saved = 250; // g
    expect(roundCanonical(saved * 0.75)).toBe(187.5);
    expect(roundCanonical(saved * 3)).toBe(750);
    expect(formatScaleFactor(0.1 + 0.2)).toBe('0.3');
  });
});
