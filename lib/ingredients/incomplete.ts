/**
 * "Incomplete" for the ingredients list (decision D2, `docs/supplier-dialog-ux-plan.md`).
 *
 * It means one thing only: THIS ROW'S COST CANNOT BE TRUSTED RIGHT NOW. That is
 * the single condition worth stealing the top of the list for, because a wrong
 * price silently corrupts every recipe the ingredient appears in.
 *
 * Two traps this shape exists to avoid:
 *
 *  1. Kitchen payloads carry NO `priceCents` key at all (Sprint F4 strips it
 *     server-side), so a predicate that simply reads the price would mark the
 *     entire kitchen list incomplete. Price therefore only participates when the
 *     viewer can see prices.
 *  2. A MISSING SUPPLIER is deliberately not included. It is a real gap, but a
 *     lesser and different one — it makes purchasing incomplete, not costing
 *     wrong — and it would match most of the list on day one, drowning the rows
 *     that are actively lying about money. It keeps its own affordances: the row's
 *     "Set supplier" button and the Supplier sort key.
 *
 * `needsPricing` alone is not enough: a manager can create an ingredient without
 * typing a price and the flag stays false, so the zero check closes that hole.
 * Both conditions say the same thing to the user — "this is costing your recipes
 * at zero".
 */

/** The only fields the rule reads. `priceCents` absent = the viewer never got one. */
export type IncompleteCandidate = {
  needsPricing: boolean;
  priceCents?: number | null;
};

export function isIncomplete(row: IncompleteCandidate, canSeeCosts: boolean): boolean {
  return row.needsPricing || (canSeeCosts && (row.priceCents ?? 0) === 0);
}
