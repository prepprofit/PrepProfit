import { describe, expect, it } from 'vitest';
import { payrollSummary, shiftPayCents, shiftWorkedMinutes } from './payroll';

/** Build an epoch-ms timestamp from an ISO string for readable fixtures. */
const at = (iso: string) => new Date(iso).getTime();

describe('shiftWorkedMinutes', () => {
  it('computes a plain same-day shift minus the break', () => {
    const shift = {
      startedAtMs: at('2026-06-17T09:00:00Z'),
      endedAtMs: at('2026-06-17T17:30:00Z'),
      breakMinutes: 30,
    };
    expect(shiftWorkedMinutes(shift)).toBe(8 * 60); // 8.5h − 30m = 8h
  });

  it('handles a shift that crosses midnight (absolute instants)', () => {
    const shift = {
      startedAtMs: at('2026-06-17T22:00:00Z'),
      endedAtMs: at('2026-06-18T02:00:00Z'),
      breakMinutes: 0,
    };
    expect(shiftWorkedMinutes(shift)).toBe(4 * 60);
  });

  it('an open shift (no end) contributes 0', () => {
    expect(
      shiftWorkedMinutes({
        startedAtMs: at('2026-06-17T09:00:00Z'),
        endedAtMs: null,
        breakMinutes: 0,
      }),
    ).toBe(0);
  });

  it('end before start yields 0 (never negative)', () => {
    expect(
      shiftWorkedMinutes({
        startedAtMs: at('2026-06-17T17:00:00Z'),
        endedAtMs: at('2026-06-17T09:00:00Z'),
        breakMinutes: 0,
      }),
    ).toBe(0);
  });

  it('a break longer than the shift clamps to 0', () => {
    expect(
      shiftWorkedMinutes({
        startedAtMs: at('2026-06-17T09:00:00Z'),
        endedAtMs: at('2026-06-17T10:00:00Z'),
        breakMinutes: 120,
      }),
    ).toBe(0);
  });
});

describe('shiftPayCents', () => {
  it('pays worked time at the hourly rate', () => {
    // 8h at €12.50/h = €100.00.
    const shift = {
      startedAtMs: at('2026-06-17T09:00:00Z'),
      endedAtMs: at('2026-06-17T17:00:00Z'),
      breakMinutes: 0,
    };
    expect(shiftPayCents(shift, 1250)).toBe(10000);
  });

  it('prorates a partial hour and rounds to cents', () => {
    // 90 min at €10.00/h = €15.00.
    const shift = {
      startedAtMs: at('2026-06-17T09:00:00Z'),
      endedAtMs: at('2026-06-17T10:30:00Z'),
      breakMinutes: 0,
    };
    expect(shiftPayCents(shift, 1000)).toBe(1500);
  });

  it('a zero rate yields zero pay', () => {
    const shift = {
      startedAtMs: at('2026-06-17T09:00:00Z'),
      endedAtMs: at('2026-06-17T17:00:00Z'),
      breakMinutes: 0,
    };
    expect(shiftPayCents(shift, 0)).toBe(0);
  });
});

describe('payrollSummary', () => {
  it('aggregates worked minutes and pay across shifts', () => {
    const shifts = [
      {
        startedAtMs: at('2026-06-15T09:00:00Z'),
        endedAtMs: at('2026-06-15T17:00:00Z'),
        breakMinutes: 0,
      }, // 480 min
      {
        startedAtMs: at('2026-06-16T22:00:00Z'),
        endedAtMs: at('2026-06-17T02:00:00Z'),
        breakMinutes: 30,
      }, // 210 min
    ];
    const summary = payrollSummary(shifts, 1200);
    expect(summary.shiftCount).toBe(2);
    expect(summary.workedMinutes).toBe(690);
    // 480 min → €96.00, 210 min → €42.00 ⇒ €138.00.
    expect(summary.payDueCents).toBe(13800);
  });

  it('ignores open shifts in the totals but counts them', () => {
    const summary = payrollSummary(
      [
        {
          startedAtMs: at('2026-06-17T09:00:00Z'),
          endedAtMs: null,
          breakMinutes: 0,
        },
      ],
      1000,
    );
    expect(summary).toEqual({ shiftCount: 1, workedMinutes: 0, payDueCents: 0 });
  });

  it('an empty period is all-zero', () => {
    expect(payrollSummary([], 1500)).toEqual({
      shiftCount: 0,
      workedMinutes: 0,
      payDueCents: 0,
    });
  });
});
