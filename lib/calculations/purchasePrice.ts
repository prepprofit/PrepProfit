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

/**
 * How a supplier expresses the price they quote:
 *  - `pack`   → the WHOLE purchase (a 4 × 1.65 kg case costs €X)
 *  - `inner`  → one inner unit of the case (each 1.65 kg bag costs €X)
 *  - `priced` → the ingredient's priced unit (per kg / litre / piece)
 */
export type SupplierPriceBasis = 'pack' | 'inner' | 'priced';

export type SupplierPriceEntry = {
  /** The quoted price, integer cents, exactly as entered. */
  priceCents: number;
  basis: SupplierPriceBasis;
  /** True when the quoted price already contains VAT. */
  includesVat: boolean;
  /** The org's VAT rate in basis points (2300 = 23%). NULL = not configured. */
  taxRateBps: number | null;
  /** Inner units in one purchase (a 4 × 1.65 kg case → 4; a lone sack → 1). */
  unitsPerPack: number;
  /** Size of ONE inner unit, in `packUnit`. */
  packSize: number;
  packUnit: Unit;
  /** The ingredient's dimension — selects the priced unit (per kg/l/piece). */
  dimension: Dimension;
};

/** The purchase's total quantity in `packUnit` (case quantity × inner size). */
function totalPackSize(entry: Pick<SupplierPriceEntry, 'unitsPerPack' | 'packSize'>): number {
  return entry.unitsPerPack * entry.packSize;
}

/**
 * Normalize a quoted supplier price into the canonical stored shape: the price of
 * the WHOLE purchase, EXCLUDING VAT, in integer cents.
 *
 * Returns `null` when the quote includes VAT but the org has no VAT rate configured
 * (`taxRateBps` NULL) — the net price is then genuinely unknowable, so we never
 * guess 0%. Throws {@link InvalidPackSizeError} for a pack that doesn't convert to a
 * positive quantity (same guard as {@link approvedPriceCents}).
 */
export function packPriceExclVatCents(entry: SupplierPriceEntry): number | null {
  const canonicalTotal = toCanonical(totalPackSize(entry), entry.packUnit);
  if (!(canonicalTotal > 0) || !(entry.unitsPerPack > 0)) {
    throw new InvalidPackSizeError();
  }

  // Scale the quote up to the whole purchase, still gross-or-net as entered.
  let gross: number;
  if (entry.basis === 'pack') {
    gross = entry.priceCents;
  } else if (entry.basis === 'inner') {
    gross = entry.priceCents * entry.unitsPerPack;
  } else {
    gross =
      (entry.priceCents * canonicalTotal) /
      CANONICAL_PER_PRICE_UNIT[entry.dimension];
  }

  if (!entry.includesVat) return Math.round(gross);
  if (entry.taxRateBps == null) return null;
  return Math.round(gross / (1 + entry.taxRateBps / 10_000));
}

/**
 * Inverse of {@link packPriceExclVatCents}: render a STORED whole-pack net price
 * back in the basis + VAT mode the supplier quotes in, so reopening the editor
 * shows the manager the number they originally typed rather than a normalized one.
 *
 * Returns `null` when a VAT-inclusive display is asked for with no configured rate
 * (the gross figure is unknowable, same rule as the forward direction). Display
 * only: a round trip can differ by a cent, so the caller must send the STORED cents
 * back unchanged when the manager never touched the price.
 */
export function quotedPriceCents(
  entry: Omit<SupplierPriceEntry, 'priceCents'> & { packPriceExclVatCents: number },
): number | null {
  const canonicalTotal = toCanonical(totalPackSize(entry), entry.packUnit);
  if (!(canonicalTotal > 0) || !(entry.unitsPerPack > 0)) {
    throw new InvalidPackSizeError();
  }

  let net: number;
  if (entry.basis === 'pack') {
    net = entry.packPriceExclVatCents;
  } else if (entry.basis === 'inner') {
    net = entry.packPriceExclVatCents / entry.unitsPerPack;
  } else {
    net =
      (entry.packPriceExclVatCents * CANONICAL_PER_PRICE_UNIT[entry.dimension]) /
      canonicalTotal;
  }

  if (!entry.includesVat) return Math.round(net);
  if (entry.taxRateBps == null) return null;
  return Math.round(net * (1 + entry.taxRateBps / 10_000));
}

/** The live readout under the supplier dialog's pack + price fields. */
export type SupplierUnitCost = {
  /** Whole-purchase price excl. VAT — what `pack_price_cents` stores. */
  packPriceExclVatCents: number;
  /** Cost per kg / litre / piece excl. VAT — what feeds recipe costs. */
  perPricedUnitExclVatCents: number;
  /** Same cost incl. VAT, or null when the org has no VAT rate configured. */
  perPricedUnitInclVatCents: number | null;
};

/**
 * Derive the cost per priced unit (per kg / litre / piece) from a quoted supplier
 * price — the number that catches a case-pack typo before it reaches a recipe.
 * `null` when the net price can't be determined (gross quote, no VAT rate).
 */
export function supplierUnitCost(entry: SupplierPriceEntry): SupplierUnitCost | null {
  const exclVat = packPriceExclVatCents(entry);
  if (exclVat == null) return null;

  const perUnitExcl = approvedPriceCents({
    packPriceCents: exclVat,
    packSize: totalPackSize(entry),
    packUnit: entry.packUnit,
    dimension: entry.dimension,
  });

  return {
    packPriceExclVatCents: exclVat,
    perPricedUnitExclVatCents: perUnitExcl,
    perPricedUnitInclVatCents:
      entry.taxRateBps == null
        ? null
        : Math.round(perUnitExcl * (1 + entry.taxRateBps / 10_000)),
  };
}
