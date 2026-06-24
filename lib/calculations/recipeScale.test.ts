import { describe, expect, it } from 'vitest';
import {
  RECIPE_SCALE_QUANTITY_MAX,
  deriveScale,
  roundCanonical,
  scaleLineQuantity,
  scaleMoneyCents,
} from './recipeScale';

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
