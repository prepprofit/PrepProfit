/**
 * Margin and pricing helpers. Pure functions, integer cents in / out.
 *
 * Margin here is gross margin on the selling price: (price − cost) / price. A
 * traffic light turns that into an at-a-glance signal for the recipe editor.
 */

export type MarginLight = 'green' | 'yellow' | 'red';

/** Gross-margin thresholds (percent) for the traffic light. */
export const MARGIN_THRESHOLDS = { green: 65, yellow: 40 } as const;

/** Gross margin as a percentage, rounded to one decimal. Returns 0 if price ≤ 0. */
export function marginPercent(costCents: number, priceCents: number): number {
  if (priceCents <= 0) return 0;
  const margin = ((priceCents - costCents) / priceCents) * 100;
  return Math.round(margin * 10) / 10;
}

/**
 * Selling price (cents) that achieves a target gross margin from a cost.
 * `suggestedPriceCents(117, 70)` → `390`. Returns 0 for an unreachable target
 * (≥ 100%).
 */
export function suggestedPriceCents(
  costCents: number,
  targetMarginPercent: number,
): number {
  if (targetMarginPercent >= 100) return 0;
  const denominator = 1 - targetMarginPercent / 100;
  if (denominator <= 0) return 0;
  return Math.round(costCents / denominator);
}

/** Map a margin percentage to a traffic-light signal. */
export function trafficLight(marginPct: number): MarginLight {
  if (marginPct >= MARGIN_THRESHOLDS.green) return 'green';
  if (marginPct >= MARGIN_THRESHOLDS.yellow) return 'yellow';
  return 'red';
}
