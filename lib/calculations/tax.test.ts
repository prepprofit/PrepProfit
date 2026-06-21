import { describe, expect, it } from 'vitest';
import {
  MAX_TAX_RATE_BPS,
  bpsToPercent,
  lineTax,
  percentToBps,
  saleLineTotals,
  saleTotals,
} from './tax';
import { movesStock } from '@/lib/finance/stock-control';

/**
 * Sprint F5 — sales tax (integer basis points, exclusive, line-level half-up) +
 * financial-only mode helper. Pure functions, no I/O.
 */
describe('lineTax', () => {
  it('rounds half-up at the cent boundary', () => {
    // 50 net @ 300 bps (3%) = 1.5 → rounds to 2.
    expect(lineTax(50, 300)).toBe(2);
    // 10 net @ 500 bps (5%) = 0.5 → rounds to 1.
    expect(lineTax(10, 500)).toBe(1);
  });

  it('is zero at 0 bps and equals the net at 10000 bps (100%)', () => {
    expect(lineTax(1234, 0)).toBe(0);
    expect(lineTax(1234, MAX_TAX_RATE_BPS)).toBe(1234);
  });

  it('computes common VAT rates', () => {
    expect(lineTax(10000, 600)).toBe(600); // 6%
    expect(lineTax(10000, 2300)).toBe(2300); // 23%
  });

  it('caps a rate above the maximum at 100%', () => {
    expect(lineTax(1000, 99999)).toBe(1000);
  });

  it('treats a non-finite rate as 0', () => {
    expect(lineTax(1000, Number.NaN)).toBe(0);
  });
});

describe('saleLineTotals', () => {
  it('returns net / tax / gross with exclusive pricing', () => {
    expect(saleLineTotals({ netCents: 10000, bps: 2300 })).toEqual({
      netCents: 10000,
      taxCents: 2300,
      grossCents: 12300,
    });
  });
});

describe('saleTotals', () => {
  it('sums the rounded per-line figures (no penny drift)', () => {
    const lines = [
      { netCents: 50, bps: 300 }, // tax 2, gross 52
      { netCents: 10, bps: 500 }, // tax 1, gross 11
    ];
    expect(saleTotals(lines)).toEqual({
      netCents: 60,
      taxCents: 3,
      grossCents: 63,
    });
  });

  it('is all-zero for an empty sale', () => {
    expect(saleTotals([])).toEqual({ netCents: 0, taxCents: 0, grossCents: 0 });
  });
});

describe('percentToBps / bpsToPercent', () => {
  it('round-trips whole and decimal percents', () => {
    expect(percentToBps(23)).toBe(2300);
    expect(percentToBps(100)).toBe(10000);
    expect(percentToBps(8.5)).toBe(850);
    expect(bpsToPercent(2300)).toBe(23);
    expect(bpsToPercent(10000)).toBe(100);
  });

  it('caps percent over 100 at 10000 bps', () => {
    expect(percentToBps(150)).toBe(MAX_TAX_RATE_BPS);
  });
});

describe('movesStock', () => {
  it('always moves stock when no start date is set', () => {
    expect(movesStock('2026-01-01', null)).toBe(true);
  });

  it('moves stock on or after the start date, not before', () => {
    expect(movesStock('2026-05-31', '2026-06-01')).toBe(false);
    expect(movesStock('2026-06-01', '2026-06-01')).toBe(true); // inclusive
    expect(movesStock('2026-06-02', '2026-06-01')).toBe(true);
  });
});
