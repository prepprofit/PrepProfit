import { describe, expect, it } from 'vitest';
import {
  PREP_CARD_FACTOR_MAX,
  formatFactorParam,
  formatPresetSelectionParam,
  parsePrepCardBasisParam,
  parsePrepCardFactorParam,
} from './kitchen-scale-print';

describe('parsePrepCardFactorParam', () => {
  it('treats missing as unscaled', () => {
    expect(parsePrepCardFactorParam(undefined)).toEqual({ ok: true, factor: null });
    expect(parsePrepCardFactorParam(null)).toEqual({ ok: true, factor: null });
  });

  it('accepts positive decimals up to 8 places', () => {
    expect(parsePrepCardFactorParam('2.5')).toEqual({ ok: true, factor: 2.5 });
    expect(parsePrepCardFactorParam('0.12345678')).toEqual({
      ok: true,
      factor: 0.12345678,
    });
  });

  it('rejects zero, negatives and blanks', () => {
    expect(parsePrepCardFactorParam('0').ok).toBe(false);
    expect(parsePrepCardFactorParam('-1').ok).toBe(false);
    expect(parsePrepCardFactorParam('').ok).toBe(false);
  });

  it('rejects non-numeric, over-precision and over-cap', () => {
    expect(parsePrepCardFactorParam('abc').ok).toBe(false);
    expect(parsePrepCardFactorParam('1.123456789').ok).toBe(false);
    expect(parsePrepCardFactorParam(String(PREP_CARD_FACTOR_MAX + 1)).ok).toBe(false);
  });

  it('rejects arrays', () => {
    expect(parsePrepCardFactorParam(['2', '3']).ok).toBe(false);
  });

  it('round-trips through formatFactorParam', () => {
    const formatted = formatFactorParam(1 / 3);
    expect(parsePrepCardFactorParam(formatted)).toEqual({
      ok: true,
      factor: Math.round((1 / 3) * 1e8) / 1e8,
    });
  });
});

describe('parsePrepCardBasisParam', () => {
  it('returns null when basis is absent', () => {
    expect(parsePrepCardBasisParam(new URLSearchParams(''))).toBeNull();
  });

  it('parses a weight basis', () => {
    expect(
      parsePrepCardBasisParam(new URLSearchParams('basis=weight&grams=3500')),
    ).toEqual({ kind: 'weight', grams: 3500 });
  });

  it('falls back to null for an invalid weight basis', () => {
    expect(
      parsePrepCardBasisParam(new URLSearchParams('basis=weight&grams=abc')),
    ).toBeNull();
    expect(parsePrepCardBasisParam(new URLSearchParams('basis=weight'))).toBeNull();
  });

  it('parses a line (ingredient-amount) basis', () => {
    expect(
      parsePrepCardBasisParam(
        new URLSearchParams('basis=line&lineId=line_1&target=900'),
      ),
    ).toEqual({ kind: 'line', lineId: 'line_1', target: 900 });
  });

  it('falls back to null for a missing lineId', () => {
    expect(
      parsePrepCardBasisParam(new URLSearchParams('basis=line&target=900')),
    ).toBeNull();
  });

  it('parses a combined-presets basis', () => {
    expect(
      parsePrepCardBasisParam(
        new URLSearchParams('basis=preset&sel=p1:45,p2:4&extra=100'),
      ),
    ).toEqual({
      kind: 'preset',
      selections: [
        { presetId: 'p1', quantity: 45 },
        { presetId: 'p2', quantity: 4 },
      ],
      extraGrams: 100,
    });
  });

  it('parses a preset basis with only an extra weight (no preset selections)', () => {
    expect(
      parsePrepCardBasisParam(new URLSearchParams('basis=preset&extra=500')),
    ).toEqual({ kind: 'preset', selections: [], extraGrams: 500 });
  });

  it('falls back to null for an empty preset basis', () => {
    expect(parsePrepCardBasisParam(new URLSearchParams('basis=preset'))).toBeNull();
  });

  it('skips malformed entries within a selection list', () => {
    expect(
      parsePrepCardBasisParam(
        new URLSearchParams('basis=preset&sel=p1:45,garbage,p2:'),
      ),
    ).toEqual({ kind: 'preset', selections: [{ presetId: 'p1', quantity: 45 }], extraGrams: 0 });
  });

  it('returns null for an unrecognized basis kind', () => {
    expect(parsePrepCardBasisParam(new URLSearchParams('basis=bogus'))).toBeNull();
  });
});

describe('formatPresetSelectionParam', () => {
  it('formats id:qty pairs joined by commas', () => {
    expect(
      formatPresetSelectionParam([
        { presetId: 'p1', quantity: 45 },
        { presetId: 'p2', quantity: 4 },
      ]),
    ).toBe('p1:45,p2:4');
  });

  it('rounds quantities to 4 decimals', () => {
    expect(
      formatPresetSelectionParam([{ presetId: 'p1', quantity: 1 / 3 }]),
    ).toBe('p1:0.3333');
  });
});
