/**
 * Break-even analysis — pure function, integer cents in / out. Powers the live
 * scenario simulator (shared by client sliders and any server use).
 *
 * Contribution margin per unit = price − variable cost. Break-even units =
 * fixed costs ÷ contribution per unit (rounded UP — you can't sell a fraction of
 * a unit to break even). When a unit contributes nothing (or loses money) there
 * is NO break-even: we return `achievable: false` and zeros, never NaN/Infinity.
 */

export type BreakEvenInput = {
  /** Total fixed costs for the period, in cents. */
  fixedCostsCents: number;
  /** Selling price per unit, in cents. */
  pricePerUnitCents: number;
  /** Variable cost per unit, in cents. */
  variableCostPerUnitCents: number;
};

export type BreakEvenResult = {
  /** price − variable cost, in cents (may be ≤ 0). */
  contributionPerUnitCents: number;
  /** True when each unit contributes a positive margin (break-even exists). */
  achievable: boolean;
  /** Units needed to cover fixed costs (ceil); 0 when unachievable or no fixed costs. */
  breakEvenUnits: number;
  /** Revenue at the break-even point, in cents; 0 when unachievable. */
  breakEvenRevenueCents: number;
};

export function breakEven(input: BreakEvenInput): BreakEvenResult {
  const contributionPerUnitCents =
    input.pricePerUnitCents - input.variableCostPerUnitCents;

  // No positive contribution → fixed costs can never be recovered; bail before
  // any division so we never produce NaN or Infinity.
  if (contributionPerUnitCents <= 0) {
    return {
      contributionPerUnitCents,
      achievable: false,
      breakEvenUnits: 0,
      breakEvenRevenueCents: 0,
    };
  }

  // Negative fixed costs are nonsensical; clamp so units never go negative.
  const fixedCostsCents = Math.max(0, input.fixedCostsCents);
  const breakEvenUnits = Math.ceil(fixedCostsCents / contributionPerUnitCents);

  return {
    contributionPerUnitCents,
    achievable: true,
    breakEvenUnits,
    breakEvenRevenueCents: breakEvenUnits * input.pricePerUnitCents,
  };
}
