import { describe, expect, it } from 'vitest';
import { approvedPriceCents, InvalidPackSizeError } from './purchasePrice';

/**
 * Sprint F2 — pack price → approved cost per priced unit (per kg / litre / piece).
 * The worked examples prove the v2 cents/gram bug is gone.
 */
describe('approvedPriceCents — worked examples (spec §4 F2)', () => {
  it('1 kg @ €5 → 500 c/kg', () => {
    expect(
      approvedPriceCents({
        packPriceCents: 500,
        packSize: 1,
        packUnit: 'kg',
        dimension: 'weight',
      }),
    ).toBe(500);
  });

  it('5 kg @ €20 → 400 c/kg', () => {
    expect(
      approvedPriceCents({
        packPriceCents: 2000,
        packSize: 5,
        packUnit: 'kg',
        dimension: 'weight',
      }),
    ).toBe(400);
  });

  it('500 ml @ €2 → 400 c/l', () => {
    expect(
      approvedPriceCents({
        packPriceCents: 200,
        packSize: 500,
        packUnit: 'ml',
        dimension: 'volume',
      }),
    ).toBe(400);
  });

  it('12 pcs @ €3 → 25 c/piece', () => {
    expect(
      approvedPriceCents({
        packPriceCents: 300,
        packSize: 12,
        packUnit: 'count',
        dimension: 'count',
      }),
    ).toBe(25);
  });
});

describe('approvedPriceCents — dimensions & units', () => {
  it('handles grams (canonical weight unit)', () => {
    // 250 g @ €1 → 100 × 1000 ÷ 250 = 400 c/kg
    expect(
      approvedPriceCents({
        packPriceCents: 100,
        packSize: 250,
        packUnit: 'g',
        dimension: 'weight',
      }),
    ).toBe(400);
  });

  it('handles litres directly', () => {
    // 2 l @ €6 → 600 × 1000 ÷ 2000 = 300 c/l
    expect(
      approvedPriceCents({
        packPriceCents: 600,
        packSize: 2,
        packUnit: 'l',
        dimension: 'volume',
      }),
    ).toBe(300);
  });
});

describe('approvedPriceCents — rounding & money edges', () => {
  it('rounds half-up to whole cents', () => {
    // 3 pcs @ €1 → 100 × 1 ÷ 3 = 33.33 → 33
    expect(
      approvedPriceCents({
        packPriceCents: 100,
        packSize: 3,
        packUnit: 'count',
        dimension: 'count',
      }),
    ).toBe(33);
    // 8 pcs @ €1 → 100 ÷ 8 = 12.5 → 13 (half-up)
    expect(
      approvedPriceCents({
        packPriceCents: 100,
        packSize: 8,
        packUnit: 'count',
        dimension: 'count',
      }),
    ).toBe(13);
  });

  it('handles a zero pack price (free sample) → 0', () => {
    expect(
      approvedPriceCents({
        packPriceCents: 0,
        packSize: 5,
        packUnit: 'kg',
        dimension: 'weight',
      }),
    ).toBe(0);
  });

  it('handles a large pack price without overflow', () => {
    // 1 kg @ €1,000,000 → 100_000_000 c/kg
    expect(
      approvedPriceCents({
        packPriceCents: 100_000_000,
        packSize: 1,
        packUnit: 'kg',
        dimension: 'weight',
      }),
    ).toBe(100_000_000);
  });
});

describe('approvedPriceCents — invalid pack guard (decision #2)', () => {
  it('throws InvalidPackSizeError on a zero pack size', () => {
    expect(() =>
      approvedPriceCents({
        packPriceCents: 500,
        packSize: 0,
        packUnit: 'kg',
        dimension: 'weight',
      }),
    ).toThrow(InvalidPackSizeError);
  });

  it('throws on a negative pack size', () => {
    expect(() =>
      approvedPriceCents({
        packPriceCents: 500,
        packSize: -1,
        packUnit: 'kg',
        dimension: 'weight',
      }),
    ).toThrow(InvalidPackSizeError);
  });

  it('throws on NaN pack size (never a silent 0 cost)', () => {
    expect(() =>
      approvedPriceCents({
        packPriceCents: 500,
        packSize: Number.NaN,
        packUnit: 'kg',
        dimension: 'weight',
      }),
    ).toThrow(InvalidPackSizeError);
  });
});
