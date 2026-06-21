import { CANONICAL_PER_PRICE_UNIT } from '@/lib/calculations/recipeCost';
import { toCanonical, type Dimension, type Unit } from '@/lib/units';

/**
 * Purchase-price model (Sprint F2). Converts the price of a purchase PACK into the
 * APPROVED COST PER PRICED UNIT (per kg / litre / piece) that `recipeCost.ts`
 * consumes as `ingredients.price_cents`. Pure, no I/O. Money is integer cents.
 *
 *   PRICE_UNIT_SIZE    = CANONICAL_PER_PRICE_UNIT[dimension]  // 1000 weight/volume, 1 count
 *   canonicalPack      = toCanonical(packSize, packUnit)       // grams / ml / count
 *   approvedPriceCents = round(packPriceCents × PRICE_UNIT_SIZE ÷ canonicalPack)
 *
 * Worked: 5 kg @ €20 → 2000 × 1000 ÷ 5000 = 400 c/kg; 12 pcs @ €3 → 300 × 1 ÷ 12 =
 * 25 c/piece. (The v2 bug returned cents/gram; this returns cents per priced unit.)
 */

/** A non-positive / NaN canonical pack size — a data bug, never a silent 0 cost. */
export class InvalidPackSizeError extends Error {
  constructor(message = 'Pack size must convert to a positive canonical quantity.') {
    super(message);
    this.name = 'InvalidPackSizeError';
  }
}

export type ApprovedPriceInput = {
  /** Price of the WHOLE pack, in integer cents. */
  packPriceCents: number;
  /** Pack quantity in `packUnit` (e.g. 5 for a 5 kg sack). */
  packSize: number;
  /** Unit the pack is sold in (kg / l / count / …). */
  packUnit: Unit;
  /** The ingredient's dimension — selects the priced unit (per kg/l/piece). */
  dimension: Dimension;
};

/** Approved cost per priced unit (cents), derived from a pack price. */
export function approvedPriceCents(input: ApprovedPriceInput): number {
  const canonicalPack = toCanonical(input.packSize, input.packUnit);
  // Catches 0, negative and NaN (NaN > 0 is false) — a zero pack would otherwise
  // divide to Infinity/0 and corrupt every recipe cost using the ingredient.
  if (!(canonicalPack > 0)) throw new InvalidPackSizeError();

  const priceUnitSize = CANONICAL_PER_PRICE_UNIT[input.dimension];
  return Math.round((input.packPriceCents * priceUnitSize) / canonicalPack);
}
