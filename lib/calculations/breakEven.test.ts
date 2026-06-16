import { describe, expect, it } from 'vitest';
import { breakEven } from './breakEven';

describe('breakEven', () => {
  it('computes contribution, units (ceil), and revenue', () => {
    const r = breakEven({
      fixedCostsCents: 100_000,
      pricePerUnitCents: 1_000,
      variableCostPerUnitCents: 400,
    });
    expect(r.contributionPerUnitCents).toBe(600);
    expect(r.achievable).toBe(true);
    // ceil(100000 / 600) = 167
    expect(r.breakEvenUnits).toBe(167);
    expect(r.breakEvenRevenueCents).toBe(167 * 1_000);
  });

  it('rounds units UP to fully cover fixed costs', () => {
    const r = breakEven({
      fixedCostsCents: 1_000,
      pricePerUnitCents: 700,
      variableCostPerUnitCents: 400,
    });
    // contribution 300; ceil(1000/300) = 4
    expect(r.breakEvenUnits).toBe(4);
    expect(r.breakEvenRevenueCents).toBe(2_800);
  });

  it('breaks even at zero units when there are no fixed costs', () => {
    const r = breakEven({
      fixedCostsCents: 0,
      pricePerUnitCents: 1_000,
      variableCostPerUnitCents: 400,
    });
    expect(r.achievable).toBe(true);
    expect(r.breakEvenUnits).toBe(0);
    expect(r.breakEvenRevenueCents).toBe(0);
  });

  it('is not achievable when contribution is zero (price = variable cost)', () => {
    const r = breakEven({
      fixedCostsCents: 50_000,
      pricePerUnitCents: 500,
      variableCostPerUnitCents: 500,
    });
    expect(r.contributionPerUnitCents).toBe(0);
    expect(r.achievable).toBe(false);
    expect(r.breakEvenUnits).toBe(0);
    expect(r.breakEvenRevenueCents).toBe(0);
  });

  it('handles a negative margin gracefully (no NaN/Infinity)', () => {
    const r = breakEven({
      fixedCostsCents: 50_000,
      pricePerUnitCents: 300,
      variableCostPerUnitCents: 500,
    });
    expect(r.contributionPerUnitCents).toBe(-200);
    expect(r.achievable).toBe(false);
    expect(Number.isFinite(r.breakEvenUnits)).toBe(true);
    expect(Number.isNaN(r.breakEvenUnits)).toBe(false);
    expect(r.breakEvenUnits).toBe(0);
  });

  it('clamps nonsensical negative fixed costs to zero', () => {
    const r = breakEven({
      fixedCostsCents: -5_000,
      pricePerUnitCents: 1_000,
      variableCostPerUnitCents: 400,
    });
    expect(r.achievable).toBe(true);
    expect(r.breakEvenUnits).toBe(0);
  });
});
