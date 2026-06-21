/**
 * Financial-only mode (Sprint F5). An org may set a `stock_control_start_date`:
 * an event (a posted sale / production) dated BEFORE it still books its
 * revenue/cost, but does NOT move stock — so importing historical activity can't
 * wreck the current on-hand quantities.
 *
 * IMPORTANT — evaluated AT POSTING TIME ONLY. Changing the start date later does
 * NOT retroactively recalculate or reverse movements already posted; past stock
 * stays exactly as recorded. Consumers (Sprint 12a/12b) call this when an event is
 * posted, never as a historical re-derivation.
 *
 * Dates are bare 'YYYY-MM-DD' strings compared lexicographically (tz-free, the
 * same approach as the finance buckets). A null start date = stock control is
 * always active (every event moves stock).
 */
export function movesStock(eventDate: string, startDate: string | null): boolean {
  if (startDate === null) return true;
  return eventDate >= startDate;
}
