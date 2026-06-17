/**
 * Period math for the payroll summary — pure, UTC-based, no I/O. A shift is
 * attributed to the period its `started_at` instant falls in. A period is a
 * calendar month or a Monday-based week, anchored on a 'YYYY-MM-DD' date; the
 * range is half-open [fromMs, toMs) so adjacent periods never double-count a
 * midnight-boundary shift.
 */

export type PayrollView = 'week' | 'month';

export type PayrollPeriod = {
  view: PayrollView;
  /** Inclusive lower bound (epoch ms). */
  fromMs: number;
  /** Exclusive upper bound (epoch ms). */
  toMs: number;
  /** Canonical first-day anchor of THIS period ('YYYY-MM-DD'). */
  anchor: string;
  /** Anchor of the previous period (for prev navigation). */
  prevAnchor: string;
  /** Anchor of the next period (for next navigation). */
  nextAnchor: string;
};

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' → UTC midnight epoch ms (NaN-safe to today on a bad string). */
function ymdToUtcMs(ymd: string, now: Date): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** UTC epoch ms → 'YYYY-MM-DD'. */
function utcMsToYmd(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** True for a well-formed 'YYYY-MM-DD' anchor. */
export function isValidAnchor(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Today as a 'YYYY-MM-DD' anchor (UTC). */
export function todayAnchor(now: Date = new Date()): string {
  return utcMsToYmd(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function resolvePayrollPeriod(
  view: PayrollView,
  anchorYmd: string,
  now: Date = new Date(),
): PayrollPeriod {
  const baseMs = ymdToUtcMs(anchorYmd, now);

  if (view === 'month') {
    const d = new Date(baseMs);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth();
    const fromMs = Date.UTC(year, month, 1);
    const toMs = Date.UTC(year, month + 1, 1);
    return {
      view,
      fromMs,
      toMs,
      anchor: utcMsToYmd(fromMs),
      prevAnchor: utcMsToYmd(Date.UTC(year, month - 1, 1)),
      nextAnchor: utcMsToYmd(toMs),
    };
  }

  // Week: snap back to Monday (getUTCDay: 0=Sun..6=Sat → Monday offset).
  const dow = new Date(baseMs).getUTCDay();
  const mondayOffset = (dow + 6) % 7;
  const fromMs = baseMs - mondayOffset * DAY_MS;
  const toMs = fromMs + 7 * DAY_MS;
  return {
    view,
    fromMs,
    toMs,
    anchor: utcMsToYmd(fromMs),
    prevAnchor: utcMsToYmd(fromMs - 7 * DAY_MS),
    nextAnchor: utcMsToYmd(toMs),
  };
}
