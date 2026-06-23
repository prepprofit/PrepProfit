/**
 * Inventory storage-area math (Sprint 12c). Pure functions, no I/O.
 *
 * Two tiny but invariant-critical pieces of stock arithmetic live here (CLAUDE rule:
 * stock math lives in `lib/calculations/` with rounding + edge tests):
 *
 *  - `countAdjustment(counted, system)` — the signed F1 `adjustment` delta a physical
 *    count must post so the per-area ledger balance becomes the counted value:
 *    `delta = counted − system`. A positive delta is found stock, a negative delta is
 *    shrinkage; a zero delta means no movement is posted.
 *  - `reconcileAreaTotals(perArea)` — sums the per-area balances back to the org total,
 *    proving the balance invariant `Σ per-area == ingredients.stock_quantity`.
 *
 * Both round to the canonical `numeric(12,2)` storage domain at the single boundary
 * (`roundCanonical`), so a fractional sum never drifts past two decimals. This module
 * NEVER touches money — areas/transfers/counts carry no monetary fields.
 */

import { roundCanonical } from '@/lib/calculations/production';

export { roundCanonical, NUMERIC_12_2_MAX } from '@/lib/calculations/production';

/**
 * The signed adjustment delta a count must post: `counted − system`, rounded to the
 * canonical 2-decimal domain. `0` ⇒ the ledger already matches reality (no movement).
 */
export function countAdjustment(counted: number, system: number): number {
  return roundCanonical(counted - system);
}

/** One per-area balance line (an area's summed `delta_canonical`). */
export type AreaBalance = {
  /** The concrete area id, or `null` for the legacy/default NULL bucket. */
  storageAreaId: string | null;
  /** Summed canonical balance for the area (may be negative for the NULL bucket). */
  balance: number;
};

/**
 * Sum per-area balances back to the org total (the balance invariant:
 * `Σ per-area == ingredients.stock_quantity`). Rounded to the canonical domain so the
 * reconciliation is exact at 2 decimals.
 */
export function reconcileAreaTotals(perArea: AreaBalance[]): number {
  return roundCanonical(perArea.reduce((sum, a) => sum + a.balance, 0));
}
