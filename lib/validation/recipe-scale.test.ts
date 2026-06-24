import { describe, expect, it } from 'vitest';
import { parseScaleParam, RECIPE_SCALE_PORTIONS_MAX } from './recipe-scale';

describe('parseScaleParam', () => {
  it('treats missing as unscaled', () => {
    expect(parseScaleParam(undefined)).toEqual({ ok: true, portions: null });
    expect(parseScaleParam(null)).toEqual({ ok: true, portions: null });
  });

  it('accepts positive decimals up to 4 places', () => {
    expect(parseScaleParam('20')).toEqual({ ok: true, portions: 20 });
    expect(parseScaleParam('18.5')).toEqual({ ok: true, portions: 18.5 });
    expect(parseScaleParam('0.3333')).toEqual({ ok: true, portions: 0.3333 });
  });

  it('rejects zero, negatives and blanks', () => {
    expect(parseScaleParam('0').ok).toBe(false);
    expect(parseScaleParam('-5').ok).toBe(false);
    expect(parseScaleParam('').ok).toBe(false);
    expect(parseScaleParam('   ').ok).toBe(false);
  });

  it('rejects non-numeric, over-precision and over-cap', () => {
    expect(parseScaleParam('abc').ok).toBe(false);
    expect(parseScaleParam('1.23456').ok).toBe(false);
    expect(parseScaleParam(String(RECIPE_SCALE_PORTIONS_MAX + 1)).ok).toBe(false);
  });

  it('rejects arrays (repeated query params)', () => {
    expect(parseScaleParam(['5', '6']).ok).toBe(false);
  });

  it('accepts the exact cap', () => {
    expect(parseScaleParam(String(RECIPE_SCALE_PORTIONS_MAX))).toEqual({
      ok: true,
      portions: RECIPE_SCALE_PORTIONS_MAX,
    });
  });
});
