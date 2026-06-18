import { describe, expect, it } from 'vitest';
import { buildPayrollData, formatHours } from './payroll-data';
import { payrollSummary } from '@/lib/calculations/payroll';
import type { SellerSettings } from './seller';

const settings: SellerSettings = {
  currency: 'EUR',
  businessName: 'Padaria',
  businessAddress: null,
  businessTaxId: null,
  businessEmail: null,
  businessLogoUrl: null,
};

const opts = {
  periodLabel: 'June 2026',
  view: 'month' as const,
  settings,
  orgNameFallback: null,
};

// 2026-06-01 08:00 → 16:30 UTC, 30m break = 8h paid.
const shiftA = {
  employeeId: 'e1',
  startedAt: new Date(Date.UTC(2026, 5, 1, 8, 0)),
  endedAt: new Date(Date.UTC(2026, 5, 1, 16, 30)),
  breakMinutes: 30,
};
// Open shift contributes 0.
const shiftOpen = {
  employeeId: 'e1',
  startedAt: new Date(Date.UTC(2026, 5, 2, 9, 0)),
  endedAt: null,
  breakMinutes: 0,
};

const employees = [
  { id: 'e1', name: 'Ana', hourlyRateCents: 1200 },
  { id: 'e2', name: 'Beto', hourlyRateCents: 1500 },
];

describe('buildPayrollData', () => {
  it('reconciles per-employee rows with payrollSummary', () => {
    const data = buildPayrollData(employees, [shiftA, shiftOpen], opts);
    const expected = payrollSummary(
      [
        { startedAtMs: shiftA.startedAt.getTime(), endedAtMs: shiftA.endedAt.getTime(), breakMinutes: 30 },
        { startedAtMs: shiftOpen.startedAt.getTime(), endedAtMs: null, breakMinutes: 0 },
      ],
      1200,
    );
    const ana = data.rows.find((r) => r.name === 'Ana')!;
    expect(ana.shiftCount).toBe(expected.shiftCount);
    expect(ana.workedMinutes).toBe(expected.workedMinutes);
    expect(ana.payDueCents).toBe(expected.payDueCents);
    expect(ana.workedMinutes).toBe(480); // open shift = 0, so just the 8h one
    expect(ana.payDueCents).toBe(9600);
  });

  it('sums period totals across employees', () => {
    const data = buildPayrollData(employees, [shiftA, shiftOpen], opts);
    expect(data.totalShiftCount).toBe(2); // Ana's 2 shifts; Beto has 0
    expect(data.totalWorkedMinutes).toBe(480);
    expect(data.totalPayCents).toBe(9600);
  });

  it('handles no shifts (zeroed totals)', () => {
    const data = buildPayrollData(employees, [], opts);
    expect(data.totalShiftCount).toBe(0);
    expect(data.totalPayCents).toBe(0);
    expect(data.rows.every((r) => r.payDueCents === 0)).toBe(true);
  });

  it('formatHours renders Hh Mm', () => {
    expect(formatHours(0)).toBe('0h 0m');
    expect(formatHours(95)).toBe('1h 35m');
    expect(formatHours(480)).toBe('8h 0m');
  });
});
