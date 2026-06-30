import { describe, expect, it } from 'vitest';
import {
  RECIPE_SCALE_QUANTITY_MAX,
  deriveScale,
  roundCanonical,
  scaleLineQuantity,
  scaleMoneyCents,
  sumPresetBasketGrams,
} from './recipeScale';

describe('sumPresetBasketGrams — preset basket composition', () => {
  it('sums each preset weight × quantity', () => {
    expect(
      sumPresetBasketGrams([
        { targetWeightGrams: 60, quantity: 3 },
        { targetWeightGrams: 140, quantity: 2 },
      ]),
    ).toBe(60 * 3 + 140 * 2);
  });

  it('adds the loose custom weight on top', () => {
    expect(
      sumPresetBasketGrams([{ targetWeightGrams: 60, quantity: 2 }], 1200),
    ).toBe(120 + 1200);
  });

  it('treats unfilled / non-positive / non-finite quantities as zero', () => {
    expect(
      sumPresetBasketGrams([
        { targetWeightGrams: 60, quantity: 0 },
        { targetWeightGrams: 140, quantity: -2 },
        { targetWeightGrams: 200, quantity: Number.NaN },
        { targetWeightGrams: 80, quantity: 1 },
      ]),
    ).toBe(80);
  });

  it('ignores lines with a non-positive per-unit weight', () => {
    expect(
      sumPresetBasketGrams([
        { targetWeightGrams: 0, quantity: 5 },
        { targetWeightGrams: -10, quantity: 5 },
      ]),
    ).toBe(0);
  });

  it('returns 0 for an empty basket with no custom weight', () => {
    expect(sumPresetBasketGrams([])).toBe(0);
    expect(sumPresetBasketGrams([], Number.NaN)).toBe(0);
  });

  it('supports fractional quantities', () => {
    expect(sumPresetBasketGrams([{ targetWeightGrams: 100, quantity: 1.5 }])).toBe(150);
  });
});

describe('deriveScale — target portions mode', () => {
  it('4 → 20 portions gives factor 5', () => {
    const r = deriveScale(4, { kind: 'portions', targetPortions: 20 });
    expect(r).toEqual({ ok: true, factor: 5, scaledPortions: 20 });
  });

  it('10 → 5 portions gives factor 0.5', () => {
    const r = deriveScale(10, { kind: 'portions', targetPortions: 5 });
    expect(r).toEqual({ ok: true, factor: 0.5, scaledPortions: 5 });
  });

  it('factor of exactly 1 is identity', () => {
    const r = deriveScale(8, { kind: 'portions', targetPortions: 8 });
    expect(r).toEqual({ ok: true, factor: 1, scaledPortions: 8 });
  });

  it('rejects a target ≤ 0', () => {
    expect(deriveScale(4, { kind: 'portions', targetPortions: 0 })).toEqual({
      ok: false,
      reason: 'invalid_target',
    });
    expect(deriveScale(4, { kind: 'portions', targetPortions: -3 })).toEqual({
      ok: false,
      reason: 'invalid_target',
    });
  });

  it('rejects a non-finite target', () => {
    expect(
      deriveScale(4, { kind: 'portions', targetPortions: Number.NaN }),
    ).toEqual({ ok: false, reason: 'invalid_target' });
    expect(
      deriveScale(4, { kind: 'portions', targetPortions: Number.POSITIVE_INFINITY }),
    ).toEqual({ ok: false, reason: 'invalid_target' });
  });

  it('rejects an invalid yield (≤ 0 or non-finite)', () => {
    expect(deriveScale(0, { kind: 'portions', targetPortions: 10 })).toEqual({
      ok: false,
      reason: 'invalid_yield',
    });
    expect(
      deriveScale(Number.NaN, { kind: 'portions', targetPortions: 10 }),
    ).toEqual({ ok: false, reason: 'invalid_yield' });
  });
});

describe('deriveScale — anchor ingredient mode', () => {
  it('anchored line reads back at its target, others scale by the same factor', () => {
    // Anchor a 500 g line to 1500 g → factor 3.
    const r = deriveScale(
      4,
      { kind: 'anchor', anchorLineQuantity: 500, targetCanonical: 1500 },
      [500, 200, 6],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.factor).toBe(3);
    // anchored line reads back exactly at the 2-decimal boundary
    expect(scaleLineQuantity(500, r.factor)).toBe(1500);
    // other lines scale by the same factor
    expect(scaleLineQuantity(200, r.factor)).toBe(600);
    expect(scaleLineQuantity(6, r.factor)).toBe(18);
  });

  it('can produce fractional portions', () => {
    // 250 g anchored to 625 g → factor 2.5 → 4 portions become 10? use odd yield.
    const r = deriveScale(3, {
      kind: 'anchor',
      anchorLineQuantity: 250,
      targetCanonical: 625,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.factor).toBe(2.5);
    expect(r.scaledPortions).toBe(7.5);
  });

  it('rejects an anchor line quantity ≤ 0', () => {
    expect(
      deriveScale(4, {
        kind: 'anchor',
        anchorLineQuantity: 0,
        targetCanonical: 100,
      }),
    ).toEqual({ ok: false, reason: 'invalid_anchor' });
  });

  it('rejects an anchor target ≤ 0 or non-finite', () => {
    expect(
      deriveScale(4, {
        kind: 'anchor',
        anchorLineQuantity: 100,
        targetCanonical: 0,
      }),
    ).toEqual({ ok: false, reason: 'invalid_anchor' });
    expect(
      deriveScale(4, {
        kind: 'anchor',
        anchorLineQuantity: 100,
        targetCanonical: Number.NaN,
      }),
    ).toEqual({ ok: false, reason: 'invalid_anchor' });
  });
});

describe('deriveScale — yield-weight (preset) mode', () => {
  it('scales by target finished weight: 1000 g → 1500 g gives factor 1.5', () => {
    const r = deriveScale(
      4,
      { kind: 'yieldWeight', baseWeightGrams: 1000, targetWeightGrams: 1500 },
      [500, 200],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.factor).toBe(1.5);
    expect(r.scaledPortions).toBe(6);
  });

  it('factor of exactly 1 is identity (same target as base)', () => {
    const r = deriveScale(8, {
      kind: 'yieldWeight',
      baseWeightGrams: 1200,
      targetWeightGrams: 1200,
    });
    expect(r).toEqual({ ok: true, factor: 1, scaledPortions: 8 });
  });

  it('can produce fractional portions', () => {
    const r = deriveScale(4, {
      kind: 'yieldWeight',
      baseWeightGrams: 1000,
      targetWeightGrams: 250,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.factor).toBe(0.25);
    expect(r.scaledPortions).toBe(1);
  });

  it('rejects a missing/zero/negative base weight as invalid_yield', () => {
    for (const base of [0, -100]) {
      expect(
        deriveScale(4, {
          kind: 'yieldWeight',
          baseWeightGrams: base,
          targetWeightGrams: 500,
        }),
      ).toEqual({ ok: false, reason: 'invalid_yield' });
    }
  });

  it('rejects a non-finite base weight as invalid_yield', () => {
    expect(
      deriveScale(4, {
        kind: 'yieldWeight',
        baseWeightGrams: Number.NaN,
        targetWeightGrams: 500,
      }),
    ).toEqual({ ok: false, reason: 'invalid_yield' });
    expect(
      deriveScale(4, {
        kind: 'yieldWeight',
        baseWeightGrams: Number.POSITIVE_INFINITY,
        targetWeightGrams: 500,
      }),
    ).toEqual({ ok: false, reason: 'invalid_yield' });
  });

  it('rejects a target weight ≤ 0 or non-finite as invalid_target', () => {
    expect(
      deriveScale(4, {
        kind: 'yieldWeight',
        baseWeightGrams: 1000,
        targetWeightGrams: 0,
      }),
    ).toEqual({ ok: false, reason: 'invalid_target' });
    expect(
      deriveScale(4, {
        kind: 'yieldWeight',
        baseWeightGrams: 1000,
        targetWeightGrams: Number.NaN,
      }),
    ).toEqual({ ok: false, reason: 'invalid_target' });
  });

  it('still applies the overflow guard on scaled lines', () => {
    const r = deriveScale(
      4,
      { kind: 'yieldWeight', baseWeightGrams: 1000, targetWeightGrams: 2000 }, // factor 2
      [RECIPE_SCALE_QUANTITY_MAX],
    );
    expect(r).toEqual({ ok: false, reason: 'overflow' });
  });
});

describe('deriveScale — overflow guard', () => {
  it('rejects a scaled line above RECIPE_SCALE_QUANTITY_MAX', () => {
    const r = deriveScale(
      4,
      { kind: 'portions', targetPortions: 8 }, // factor 2
      [RECIPE_SCALE_QUANTITY_MAX], // 2× exceeds the max
    );
    expect(r).toEqual({ ok: false, reason: 'overflow' });
  });

  it('allows a scaled line exactly at the max', () => {
    const r = deriveScale(
      4,
      { kind: 'portions', targetPortions: 4 }, // factor 1
      [RECIPE_SCALE_QUANTITY_MAX],
    );
    expect(r.ok).toBe(true);
  });
});

describe('rounding helpers', () => {
  it('rounds canonical quantities once to 2 decimals', () => {
    expect(roundCanonical(100.125)).toBe(100.13); // exact half rounds up
    expect(roundCanonical(33.333)).toBe(33.33);
  });

  it('scaleLineQuantity rounds once at the canonical boundary', () => {
    // 333 g × (1/3) = 111 exactly; 100 g × (1/3) = 33.333… → 33.33
    expect(scaleLineQuantity(100, 1 / 3)).toBe(33.33);
  });

  it('scaleMoneyCents rounds to whole cents', () => {
    expect(scaleMoneyCents(101, 2.5)).toBe(253); // 252.5 → 253
    expect(scaleMoneyCents(100, 0.5)).toBe(50);
  });
});
