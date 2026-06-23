import { describe, expect, it } from 'vitest';
import {
  countAdjustment,
  reconcileAreaTotals,
  NUMERIC_12_2_MAX,
} from '@/lib/calculations/inventory-areas';

describe('countAdjustment', () => {
  it('is zero when the count matches the system balance (no movement)', () => {
    expect(countAdjustment(100, 100)).toBe(0);
    expect(countAdjustment(0, 0)).toBe(0);
  });

  it('is positive when more was counted than the ledger knows (found stock)', () => {
    expect(countAdjustment(120, 100)).toBe(20);
  });

  it('is negative when less was counted than the ledger knows (shrinkage)', () => {
    expect(countAdjustment(80, 100)).toBe(-20);
  });

  it('counts down to exactly zero from a positive system balance', () => {
    expect(countAdjustment(0, 100)).toBe(-100);
  });

  it('reconciles a negative system balance up to the counted value', () => {
    // The default/NULL bucket can be negative from area-agnostic consumption.
    expect(countAdjustment(50, -10)).toBe(60);
  });

  it('rounds to the canonical 2-decimal domain', () => {
    expect(countAdjustment(10.005, 0)).toBeCloseTo(10.01, 5);
    expect(countAdjustment(1 / 3, 0)).toBe(0.33);
  });

  it('handles large values within the numeric(12,2) domain', () => {
    expect(countAdjustment(NUMERIC_12_2_MAX, 0)).toBe(NUMERIC_12_2_MAX);
  });
});

describe('reconcileAreaTotals', () => {
  it('sums an empty set to zero', () => {
    expect(reconcileAreaTotals([])).toBe(0);
  });

  it('sums named areas plus the NULL/default bucket to the org total', () => {
    const total = reconcileAreaTotals([
      { storageAreaId: 'a', balance: 30 },
      { storageAreaId: 'b', balance: 70 },
      { storageAreaId: null, balance: 50 },
    ]);
    expect(total).toBe(150);
  });

  it('reconciles when the default bucket is negative', () => {
    const total = reconcileAreaTotals([
      { storageAreaId: 'a', balance: 100 },
      { storageAreaId: null, balance: -40 },
    ]);
    expect(total).toBe(60);
  });

  it('rounds the sum to the canonical 2-decimal domain', () => {
    const total = reconcileAreaTotals([
      { storageAreaId: 'a', balance: 0.1 },
      { storageAreaId: 'b', balance: 0.2 },
    ]);
    expect(total).toBe(0.3);
  });

  it('matches countAdjustment: after a count, Σ areas equals the counted value', () => {
    // One area at 80, counted to 100 → adjustment +20 → balance 100; total reconciles.
    const before = 80;
    const counted = 100;
    const delta = countAdjustment(counted, before);
    const total = reconcileAreaTotals([{ storageAreaId: 'a', balance: before + delta }]);
    expect(total).toBe(counted);
  });
});
