import { describe, expect, it } from 'vitest';
import {
  convertQuantity,
  effectiveAnchors,
  hasUsableAnchorPair,
  missingAnchorDimensions,
  type UomAnchors,
} from './uom';

// The plan's worked example: 141.75 g = 236.59 ml = 1 each.
const FULL: UomAnchors = { weightGrams: 141.75, volumeMl: 236.59, eachCount: 1 };
const WEIGHT_ONLY: UomAnchors = { weightGrams: 141.75, volumeMl: null, eachCount: null };

describe('convertQuantity', () => {
  it('same-dimension uses lib/units factors (no equivalency needed)', () => {
    expect(convertQuantity(2, 'kg', 'weight', null)).toEqual({
      ok: true,
      canonical: 2000,
      unit: 'g',
    });
    expect(convertQuantity(1, 'cup', 'volume', null)).toEqual({
      ok: true,
      canonical: 236.5882365,
      unit: 'ml',
    });
    expect(convertQuantity(3, 'count', 'count', null)).toEqual({
      ok: true,
      canonical: 3,
      unit: 'count',
    });
  });

  it('converts across dimensions through the anchors', () => {
    const volume = convertQuantity(141.75, 'g', 'volume', FULL);
    expect(volume).toEqual({ ok: true, canonical: 236.59, unit: 'ml' });

    const each = convertQuantity(473.18, 'ml', 'count', FULL);
    if (!each.ok) throw new Error('expected ok');
    expect(each.canonical).toBeCloseTo(2, 10);
    expect(each.unit).toBe('count');

    // Entry units canonicalize first: 1 cup ≈ 236.588 ml ≈ 141.749 g.
    const grams = convertQuantity(1, 'cup', 'weight', FULL);
    if (!grams.ok) throw new Error('expected ok');
    expect(grams.canonical).toBeCloseTo(141.7489434, 4);
  });

  it('round-trips weight → volume → each → weight', () => {
    const ml = convertQuantity(283.5, 'g', 'volume', FULL);
    if (!ml.ok) throw new Error('expected ok');
    const each = convertQuantity(ml.canonical, 'ml', 'count', FULL);
    if (!each.ok) throw new Error('expected ok');
    const back = convertQuantity(each.canonical, 'count', 'weight', FULL);
    if (!back.ok) throw new Error('expected ok');
    expect(back.canonical).toBeCloseTo(283.5, 8);
  });

  it('is MISSING_EQUIVALENCY when an anchor is absent — never zero', () => {
    expect(convertQuantity(100, 'g', 'volume', WEIGHT_ONLY)).toEqual({
      ok: false,
      reason: 'MISSING_EQUIVALENCY',
    });
    expect(convertQuantity(100, 'ml', 'weight', null)).toEqual({
      ok: false,
      reason: 'MISSING_EQUIVALENCY',
    });
  });

  it('treats zero/negative/non-finite anchors as absent', () => {
    const broken: UomAnchors = { weightGrams: 0, volumeMl: -5, eachCount: Number.NaN };
    expect(convertQuantity(100, 'g', 'volume', broken)).toEqual({
      ok: false,
      reason: 'MISSING_EQUIVALENCY',
    });
  });

  it('accepts zero input, rejects NaN/Infinity/negative', () => {
    expect(convertQuantity(0, 'g', 'volume', FULL)).toEqual({
      ok: true,
      canonical: 0,
      unit: 'ml',
    });
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(convertQuantity(bad, 'g', 'volume', FULL)).toEqual({
        ok: false,
        reason: 'INVALID_INPUT',
      });
    }
  });
});

describe('hasUsableAnchorPair', () => {
  it('needs at least two positive anchors', () => {
    expect(hasUsableAnchorPair(FULL)).toBe(true);
    expect(hasUsableAnchorPair({ weightGrams: 10, volumeMl: 20, eachCount: null })).toBe(true);
    expect(hasUsableAnchorPair(WEIGHT_ONLY)).toBe(false);
    expect(hasUsableAnchorPair(null)).toBe(false);
    expect(
      hasUsableAnchorPair({ weightGrams: 10, volumeMl: 0, eachCount: Number.NaN }),
    ).toBe(false);
  });
});

describe('effectiveAnchors', () => {
  it('prep anchors replace the base entirely when any is set', () => {
    const prep: UomAnchors = { weightGrams: 80, volumeMl: null, eachCount: 1 };
    expect(effectiveAnchors(FULL, prep)).toBe(prep);
  });

  it('falls back to the base when the prep has no usable anchors', () => {
    expect(effectiveAnchors(FULL, null)).toBe(FULL);
    expect(
      effectiveAnchors(FULL, { weightGrams: null, volumeMl: null, eachCount: null }),
    ).toBe(FULL);
    expect(effectiveAnchors(null, null)).toBeNull();
  });
});

describe('missingAnchorDimensions', () => {
  it('names exactly the missing sides of the conversion', () => {
    expect(missingAnchorDimensions('weight', 'weight', null)).toEqual([]);
    expect(missingAnchorDimensions('weight', 'volume', FULL)).toEqual([]);
    expect(missingAnchorDimensions('weight', 'volume', WEIGHT_ONLY)).toEqual(['volume']);
    expect(missingAnchorDimensions('volume', 'count', WEIGHT_ONLY)).toEqual([
      'volume',
      'count',
    ]);
    expect(missingAnchorDimensions('volume', 'weight', null)).toEqual([
      'volume',
      'weight',
    ]);
  });
});
