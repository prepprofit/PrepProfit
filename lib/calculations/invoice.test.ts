import { describe, expect, it } from 'vitest';
import { invoiceTotals, lineTotals } from './invoice';

describe('lineTotals', () => {
  it('computes net, tax and gross for a standard line', () => {
    // 2 × €10.00 = €20.00 net; 23% VAT = €4.60; €24.60 gross.
    expect(lineTotals({ quantity: 2, unitPriceCents: 1000, taxRate: 23 })).toEqual({
      netCents: 2000,
      taxCents: 460,
      grossCents: 2460,
    });
  });

  it('handles a 0% tax rate (net == gross)', () => {
    expect(lineTotals({ quantity: 3, unitPriceCents: 500, taxRate: 0 })).toEqual({
      netCents: 1500,
      taxCents: 0,
      grossCents: 1500,
    });
  });

  it('zero quantity yields all-zero totals', () => {
    expect(lineTotals({ quantity: 0, unitPriceCents: 1234, taxRate: 23 })).toEqual({
      netCents: 0,
      taxCents: 0,
      grossCents: 0,
    });
  });

  it('rounds a fractional quantity to whole cents', () => {
    // 1.5 × 333 = 499.5 → 500 net; 500 × 13% = 65 tax.
    expect(lineTotals({ quantity: 1.5, unitPriceCents: 333, taxRate: 13 })).toEqual({
      netCents: 500,
      taxCents: 65,
      grossCents: 565,
    });
  });

  it('rounds tax half-up', () => {
    // 100 × 12.5% = 12.5 → 13.
    expect(lineTotals({ quantity: 1, unitPriceCents: 100, taxRate: 12.5 }).taxCents).toBe(
      13,
    );
  });

  it('supports a high tax rate', () => {
    expect(lineTotals({ quantity: 1, unitPriceCents: 1000, taxRate: 100 })).toEqual({
      netCents: 1000,
      taxCents: 1000,
      grossCents: 2000,
    });
  });
});

describe('invoiceTotals', () => {
  it('returns all-zero for an empty invoice', () => {
    expect(invoiceTotals([])).toEqual({
      subtotalCents: 0,
      taxCents: 0,
      totalCents: 0,
    });
  });

  it('sums the independently-rounded line figures (mixed rates)', () => {
    const totals = invoiceTotals([
      { quantity: 2, unitPriceCents: 1000, taxRate: 23 }, // 2000 / 460
      { quantity: 1, unitPriceCents: 550, taxRate: 6 }, // 550 / 33
      { quantity: 3, unitPriceCents: 100, taxRate: 0 }, // 300 / 0
    ]);
    expect(totals).toEqual({
      subtotalCents: 2850,
      taxCents: 493,
      totalCents: 3343,
    });
  });

  it('rounds per line then sums (no penny drift)', () => {
    // Each line: 1 × 1 cent × 50% = 0.5 → rounds to 1 cent of tax per line.
    // Per-line rounding => 3 cents tax; summing un-rounded (1.5) would give 2.
    const totals = invoiceTotals([
      { quantity: 1, unitPriceCents: 1, taxRate: 50 },
      { quantity: 1, unitPriceCents: 1, taxRate: 50 },
      { quantity: 1, unitPriceCents: 1, taxRate: 50 },
    ]);
    expect(totals.subtotalCents).toBe(3);
    expect(totals.taxCents).toBe(3);
    expect(totals.totalCents).toBe(6);
  });
});
