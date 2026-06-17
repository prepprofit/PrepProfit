import { describe, expect, it } from 'vitest';
import { resolvePayrollPeriod, todayAnchor } from './period';

const ms = (iso: string) => new Date(iso).getTime();

describe('resolvePayrollPeriod — month', () => {
  it('spans the calendar month [first, next-first)', () => {
    const p = resolvePayrollPeriod('month', '2026-06-17');
    expect(p.fromMs).toBe(ms('2026-06-01T00:00:00Z'));
    expect(p.toMs).toBe(ms('2026-07-01T00:00:00Z'));
    expect(p.anchor).toBe('2026-06-01');
    expect(p.prevAnchor).toBe('2026-05-01');
    expect(p.nextAnchor).toBe('2026-07-01');
  });

  it('wraps the year at December → January', () => {
    const p = resolvePayrollPeriod('month', '2026-12-10');
    expect(p.nextAnchor).toBe('2027-01-01');
    expect(p.prevAnchor).toBe('2026-11-01');
  });
});

describe('resolvePayrollPeriod — week (Monday-based)', () => {
  it('snaps a mid-week date back to Monday and spans 7 days', () => {
    // 2026-06-17 is a Wednesday → week starts Monday 2026-06-15.
    const p = resolvePayrollPeriod('week', '2026-06-17');
    expect(p.anchor).toBe('2026-06-15');
    expect(p.fromMs).toBe(ms('2026-06-15T00:00:00Z'));
    expect(p.toMs).toBe(ms('2026-06-22T00:00:00Z'));
    expect(p.prevAnchor).toBe('2026-06-08');
    expect(p.nextAnchor).toBe('2026-06-22');
  });

  it('keeps a Monday anchor as the week start', () => {
    const p = resolvePayrollPeriod('week', '2026-06-15');
    expect(p.anchor).toBe('2026-06-15');
  });

  it('treats Sunday as the last day of the week that started the prior Monday', () => {
    // 2026-06-21 is a Sunday → still in the 2026-06-15 week.
    const p = resolvePayrollPeriod('week', '2026-06-21');
    expect(p.anchor).toBe('2026-06-15');
  });
});

describe('todayAnchor', () => {
  it('formats today as YYYY-MM-DD (UTC)', () => {
    expect(todayAnchor(new Date('2026-06-17T15:30:00Z'))).toBe('2026-06-17');
  });
});
