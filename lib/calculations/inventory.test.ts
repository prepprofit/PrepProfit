import { describe, expect, it } from 'vitest';
import { isLowStock, selectLowStock } from './inventory';

describe('isLowStock', () => {
  it('is false when no threshold is set', () => {
    expect(isLowStock(0, null)).toBe(false);
    expect(isLowStock(5000, null)).toBe(false);
  });

  it('fires at or below the threshold', () => {
    expect(isLowStock(500, 1000)).toBe(true);
    expect(isLowStock(1000, 1000)).toBe(true);
    expect(isLowStock(1001, 1000)).toBe(false);
  });
});

describe('selectLowStock', () => {
  const item = (
    id: string,
    stockCanonical: number,
    thresholdCanonical: number | null,
  ) => ({ id, stockCanonical, thresholdCanonical });

  it('keeps only items at or below their threshold (most-depleted first)', () => {
    const result = selectLowStock([
      item('low', 500, 1000), // shortfall 500
      item('exact', 1000, 1000), // shortfall 0
      item('ok', 1500, 1000), // not low
      item('no-threshold', 0, null), // never low
    ]);
    expect(result.map((i) => i.id)).toEqual(['low', 'exact']);
  });

  it('orders by largest shortfall below the threshold first', () => {
    const result = selectLowStock([
      item('small-gap', 900, 1000), // shortfall 100
      item('big-gap', 100, 1000), // shortfall 900
      item('mid-gap', 600, 1000), // shortfall 400
    ]);
    expect(result.map((i) => i.id)).toEqual(['big-gap', 'mid-gap', 'small-gap']);
  });

  it('returns an empty array when nothing is low', () => {
    expect(selectLowStock([item('a', 50, null), item('b', 99, 10)])).toEqual([]);
  });
});
