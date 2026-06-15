import { describe, expect, it } from 'vitest';
import { isLowStock } from './inventory';

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
