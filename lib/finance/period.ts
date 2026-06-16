/**
 * Period math for the financials dashboards — pure, string-only, no timezone.
 * A period key is 'YYYY-MM' (month view) or 'YYYY' (year view); ranges are
 * inclusive bare-date bounds ('YYYY-MM-DD') so they pair with `occurred_on`
 * comparisons directly. The upper bound is the month's REAL last day: a fixed
 * 'YYYY-MM-31' emits impossible dates (e.g. '2026-06-31') that the DB rejects
 * when bound to the `date`-typed `occurred_on` parameter (Postgres 22008).
 */

export type PeriodView = 'month' | 'year';

export type ResolvedPeriod = {
  view: PeriodView;
  /** Canonical key: 'YYYY-MM' (month) or 'YYYY' (year). */
  key: string;
  /** Calendar year the period falls in (drives monthly buckets in year view). */
  year: number;
  from: string;
  to: string;
  /** The immediately preceding period's range, for comparison. */
  priorFrom: string;
  priorTo: string;
  prevKey: string;
  nextKey: string;
};

const pad2 = (n: number) => String(n).padStart(2, '0');

const monthKey = (year: number, month: number) => `${year}-${pad2(month)}`;
const monthFrom = (key: string) => `${key}-01`;
// Real last day of the month (day 0 of the next month), so the inclusive upper
// bound is a valid calendar date — never an impossible '2026-06-31'.
const monthTo = (key: string) => {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${key}-${pad2(lastDay)}`;
};
const yearFrom = (year: number) => `${year}-01-01`;
const yearTo = (year: number) => `${year}-12-31`;

/** The current period key for a view, using the LOCAL calendar date. */
export function currentPeriodKey(view: PeriodView, now: Date = new Date()): string {
  const year = now.getFullYear();
  return view === 'year' ? String(year) : monthKey(year, now.getMonth() + 1);
}

/** True for a well-formed key matching the view ('YYYY-MM' or 'YYYY'). */
export function isValidPeriodKey(view: PeriodView, key: string): boolean {
  return view === 'year' ? /^\d{4}$/.test(key) : /^\d{4}-\d{2}$/.test(key);
}

export function resolvePeriod(view: PeriodView, key: string): ResolvedPeriod {
  if (view === 'year') {
    const year = Number(key);
    return {
      view,
      key,
      year,
      from: yearFrom(year),
      to: yearTo(year),
      priorFrom: yearFrom(year - 1),
      priorTo: yearTo(year - 1),
      prevKey: String(year - 1),
      nextKey: String(year + 1),
    };
  }

  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  const prev =
    month === 1 ? monthKey(year - 1, 12) : monthKey(year, month - 1);
  const next =
    month === 12 ? monthKey(year + 1, 1) : monthKey(year, month + 1);

  return {
    view,
    key,
    year,
    from: monthFrom(key),
    to: monthTo(key),
    priorFrom: monthFrom(prev),
    priorTo: monthTo(prev),
    prevKey: prev,
    nextKey: next,
  };
}
