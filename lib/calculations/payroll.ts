/**
 * Payroll — pure functions, no I/O. Money is in integer cents (CLAUDE.md).
 *
 * Shifts store absolute INSTANTS (timestamptz) for check-in/out, so a shift that
 * crosses midnight is just `endedAt − startedAt`: there is no wall-clock or DST
 * math here, the calc only ever sees two epoch-millisecond values. An OPEN shift
 * (no `endedAt`) has not finished, so it contributes 0 worked minutes / 0 pay
 * until it is closed.
 */

export type ShiftInput = {
  /** Check-in instant (epoch ms). */
  startedAtMs: number;
  /** Check-out instant (epoch ms), or null while the shift is still open. */
  endedAtMs: number | null;
  /** Unpaid break within the shift, in minutes. */
  breakMinutes: number;
};

const MS_PER_MINUTE = 60_000;

/**
 * Paid minutes worked: elapsed wall time minus the unpaid break, floored at 0.
 * An open shift (no end), a non-positive span (end ≤ start), or a break that
 * swallows the whole shift all yield 0 — never a negative.
 */
export function shiftWorkedMinutes(shift: ShiftInput): number {
  if (shift.endedAtMs === null) return 0;
  const elapsedMinutes = Math.round(
    (shift.endedAtMs - shift.startedAtMs) / MS_PER_MINUTE,
  );
  if (elapsedMinutes <= 0) return 0;
  const breakMinutes = Math.max(0, shift.breakMinutes);
  return Math.max(0, elapsedMinutes - breakMinutes);
}

/** Pay due for a single shift, in integer cents, at the given hourly rate. */
export function shiftPayCents(shift: ShiftInput, hourlyRateCents: number): number {
  return Math.round((shiftWorkedMinutes(shift) / 60) * hourlyRateCents);
}

export type PayrollSummary = {
  /** Number of shifts counted. */
  shiftCount: number;
  /** Total paid minutes across the shifts. */
  workedMinutes: number;
  /** Total pay due across the shifts, in integer cents. */
  payDueCents: number;
};

/**
 * Aggregate worked minutes + pay across an employee's shifts (already filtered to
 * the period by the caller) at a single hourly rate. Pay is summed PER SHIFT (each
 * shift independently rounded), so a payslip's lines reconcile with its total.
 */
export function payrollSummary(
  shifts: ShiftInput[],
  hourlyRateCents: number,
): PayrollSummary {
  return shifts.reduce<PayrollSummary>(
    (acc, shift) => {
      const minutes = shiftWorkedMinutes(shift);
      return {
        shiftCount: acc.shiftCount + 1,
        workedMinutes: acc.workedMinutes + minutes,
        payDueCents: acc.payDueCents + shiftPayCents(shift, hourlyRateCents),
      };
    },
    { shiftCount: 0, workedMinutes: 0, payDueCents: 0 },
  );
}
