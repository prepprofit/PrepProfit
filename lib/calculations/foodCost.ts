/**
 * Food cost calculator (Recipes 2.0 Fase 5, plan §7.3) — pure, no I/O.
 * Powers the bidirectional portion-option calculator: change the selling
 * price → recompute food cost; change the target food cost → suggest a price.
 * ONE direction is active per interaction (the caller decides which function
 * to run) so the form never feeds itself into a loop.
 *
 * Money is integer cents; food cost / target are basis points (10000 = 100%).
 * Every function returns `null` when the result cannot be computed honestly
 * (missing, zero, negative or non-finite inputs) — a `null` renders as "—",
 * never a free 0.
 */

/** Ceiling mirroring the DB CHECK / Zod cap (selling_price_cents). */
const MAX_CENTS = 100_000_000;

function isValidCents(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_CENTS;
}

/**
 * Food cost of a portion, in basis points:
 *   foodCostBps = round(costCents * 10000 / sellingPriceCents)
 * `null` when either side is missing/invalid or the price is zero (dividing by
 * a free price is meaningless, not 0% food cost).
 */
export function foodCostBps(
  costCents: number | null | undefined,
  sellingPriceCents: number | null | undefined,
): number | null {
  if (costCents == null || sellingPriceCents == null) return null;
  if (!isValidCents(costCents) || !isValidCents(sellingPriceCents)) return null;
  if (sellingPriceCents <= 0) return null;
  return Math.round((costCents * 10_000) / sellingPriceCents);
}

/**
 * Gross profit of a portion, in integer cents:
 *   profitCents = sellingPriceCents - costCents
 * May be negative (selling below cost is a real, reportable state).
 */
export function profitCents(
  costCents: number | null | undefined,
  sellingPriceCents: number | null | undefined,
): number | null {
  if (costCents == null || sellingPriceCents == null) return null;
  if (!isValidCents(costCents) || !isValidCents(sellingPriceCents)) return null;
  return sellingPriceCents - costCents;
}

/**
 * Price suggestion for a target food cost (the reverse direction):
 *   suggestedPriceCents = round(costCents * 10000 / targetFoodCostBps)
 * `targetFoodCostBps` must be 1..10000 (a 0% target would demand an infinite
 * price). `null` when the cost is missing/invalid or the target out of range.
 * The suggestion is clamped to the money ceiling — a micro-cost with a tiny
 * target never overflows into a nonsense price.
 */
export function suggestedPriceCents(
  costCents: number | null | undefined,
  targetFoodCostBps: number | null | undefined,
): number | null {
  if (costCents == null || targetFoodCostBps == null) return null;
  if (!isValidCents(costCents)) return null;
  if (
    !Number.isFinite(targetFoodCostBps) ||
    targetFoodCostBps <= 0 ||
    targetFoodCostBps > 10_000
  ) {
    return null;
  }
  const suggested = Math.round((costCents * 10_000) / targetFoodCostBps);
  return Math.min(suggested, MAX_CENTS);
}

/**
 * Cost of ONE portion option as its fraction of the batch (plan §7.3: "custo
 * da porção usa a fração da porção sobre o yield total"):
 *   portionCostCents = round(totalCostCents * portionQuantity / totalYieldQuantity)
 * Quantities must share the SAME unit (the caller converts first). `null` on
 * missing/zero/negative/non-finite inputs.
 */
export function portionCostCents(
  totalCostCents: number | null | undefined,
  portionQuantity: number | null | undefined,
  totalYieldQuantity: number | null | undefined,
): number | null {
  if (
    totalCostCents == null ||
    portionQuantity == null ||
    totalYieldQuantity == null
  ) {
    return null;
  }
  if (!Number.isFinite(totalCostCents) || totalCostCents < 0) return null;
  if (!Number.isFinite(portionQuantity) || portionQuantity <= 0) return null;
  if (!Number.isFinite(totalYieldQuantity) || totalYieldQuantity <= 0) return null;
  return Math.round((totalCostCents * portionQuantity) / totalYieldQuantity);
}
