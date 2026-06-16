import { describe, expect, it } from 'vitest';
import {
  currentPeriodKey,
  isValidPeriodKey,
  resolvePeriod,
} from './period';

describe('currentPeriodKey', () => {
  it('uses the local calendar date', () => {
    const now = new Date(2026, 5, 16); // June (month index 5), local
    expect(currentPeriodKey('month', now)).toBe('2026-06');
    expect(currentPeriodKey('year', now)).toBe('2026');
  });
});

describe('isValidPeriodKey', () => {
  it('matches the view shape', () => {
    expect(isValidPeriodKey('month', '2026-06')).toBe(true);
    expect(isValidPeriodKey('month', '2026')).toBe(false);
    expect(isValidPeriodKey('year', '2026')).toBe(true);
    expect(isValidPeriodKey('year', '2026-06')).toBe(false);
  });
});

describe('resolvePeriod (month)', () => {
  it('computes inclusive bounds and neighbours', () => {
    const p = resolvePeriod('month', '2026-06');
    expect(p.from).toBe('2026-06-01');
    expect(p.to).toBe('2026-06-31');
    expect(p.prevKey).toBe('2026-05');
    expect(p.nextKey).toBe('2026-07');
    expect(p.priorFrom).toBe('2026-05-01');
    expect(p.priorTo).toBe('2026-05-31');
    expect(p.year).toBe(2026);
  });

  it('rolls over year boundaries', () => {
    expect(resolvePeriod('month', '2026-01').prevKey).toBe('2025-12');
    expect(resolvePeriod('month', '2026-12').nextKey).toBe('2027-01');
    expect(resolvePeriod('month', '2026-01').priorFrom).toBe('2025-12-01');
  });
});

describe('resolvePeriod (year)', () => {
  it('spans the whole year and compares against the prior year', () => {
    const p = resolvePeriod('year', '2026');
    expect(p.from).toBe('2026-01-01');
    expect(p.to).toBe('2026-12-31');
    expect(p.prevKey).toBe('2025');
    expect(p.nextKey).toBe('2027');
    expect(p.priorFrom).toBe('2025-01-01');
    expect(p.priorTo).toBe('2025-12-31');
  });
});
