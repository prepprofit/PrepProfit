import { payrollSummary } from '@/lib/calculations/payroll';
import type { Employee, Shift } from '@/lib/db/schema';
import type { PayrollDocumentData, PayrollDocumentRow } from './types';
import { buildSellerIdentity, type SellerSettings } from './seller';

/**
 * Pure mapping from employees + their shifts → the payroll period-summary
 * view-model (Sprint 3.5B). No I/O: the route/page loads the period's employees and
 * shifts inside `withOrg` and passes them here. Reuses the SAME `payrollSummary`
 * (per-shift rounding) the `/payroll` screen uses, so the document reconciles with
 * the on-screen figures. Money is integer cents.
 *
 * PII: rows carry employee names because a manager's summary needs them; the AUDIT
 * layer (route) records only counts — never names or per-person pay.
 */
type EmployeeLike = Pick<Employee, 'id' | 'name' | 'hourlyRateCents'>;
type ShiftLike = Pick<Shift, 'employeeId' | 'startedAt' | 'endedAt' | 'breakMinutes'>;

export function buildPayrollData(
  employees: EmployeeLike[],
  shifts: ShiftLike[],
  opts: {
    periodLabel: string;
    view: 'week' | 'month';
    settings: SellerSettings;
    orgNameFallback: string | null;
  },
): PayrollDocumentData {
  const rows: PayrollDocumentRow[] = employees.map((e) => {
    const theirShifts = shifts
      .filter((s) => s.employeeId === e.id)
      .map((s) => ({
        startedAtMs: s.startedAt.getTime(),
        endedAtMs: s.endedAt ? s.endedAt.getTime() : null,
        breakMinutes: s.breakMinutes,
      }));
    const summary = payrollSummary(theirShifts, e.hourlyRateCents);
    return {
      name: e.name,
      shiftCount: summary.shiftCount,
      workedMinutes: summary.workedMinutes,
      payDueCents: summary.payDueCents,
    };
  });

  const totals = rows.reduce(
    (acc, r) => ({
      totalShiftCount: acc.totalShiftCount + r.shiftCount,
      totalWorkedMinutes: acc.totalWorkedMinutes + r.workedMinutes,
      totalPayCents: acc.totalPayCents + r.payDueCents,
    }),
    { totalShiftCount: 0, totalWorkedMinutes: 0, totalPayCents: 0 },
  );

  return {
    seller: buildSellerIdentity(opts.settings, opts.orgNameFallback),
    periodLabel: opts.periodLabel,
    view: opts.view,
    rows,
    ...totals,
    currency: opts.settings.currency,
  };
}

/** Worked minutes → 'Hh Mm' display (e.g. 95 → '1h 35m'). Pure. */
export function formatHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m}m`;
}
