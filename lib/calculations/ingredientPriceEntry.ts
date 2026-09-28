import { CANONICAL_PER_PRICE_UNIT } from '@/lib/calculations/recipeCost';
import { convertQuantity, type UomAnchors } from '@/lib/calculations/uom';
import type { Dimension, Unit } from '@/lib/units';

/**
 * Turns the ONE price a manager typed in the ingredient editor into the two numbers
 * the system stores: the ingredient's active cost per kg / litre / piece and, when a
 * pack can honestly be priced, the whole-pack price — both EXCLUDING VAT. Pure, no
 * I/O, integer cents. The server is the authority; the editor calls the same function
 * so what it previews is what gets saved.
 *
 * Rules that keep it honest:
 *  - VAT is removed exactly once, and only when the entered price includes it. An
 *    including-VAT price with no rate is `vat_rate_required` — never an assumed 0%.
 *  - A typed price per kg (`unit`) never needs a pack: pack details only add the
 *    whole-pack price when the pack converts to the ingredient's dimension.
 *  - A typed pack price needs a pack that converts. A volume pack on a weight
 *    ingredient converts only through the ingredient's own equivalency; without one
 *    it is `needs_equivalency` (500 ml is never assumed to weigh 500 g).
 */

export type EnteredPriceSource = 'pack' | 'unit';

export type EnteredPack = {
  /** Inner units in one purchase (a 4 × 1.65 kg case → 4; a lone sack → 1). */
  unitsPerPack: number;
  /** Size of ONE inner unit, in `packUnit`. */
  packSize: number;
  packUnit: Unit;
};

export type PackQuantity =
  | { ok: true; canonical: number }
  | { ok: false; reason: 'incomplete' | 'needs_equivalency' };

/** Total purchased quantity in the ingredient's canonical unit (g / ml / count). */
export function packCanonicalQuantity(
  pack: EnteredPack | null,
  dimension: Dimension,
  anchors: UomAnchors | null,
): PackQuantity {
  if (!pack || !(pack.unitsPerPack > 0) || !(pack.packSize > 0)) {
    return { ok: false, reason: 'incomplete' };
  }
  const converted = convertQuantity(pack.unitsPerPack * pack.packSize, pack.packUnit, dimension, anchors);
  if (!converted.ok) {
    return { ok: false, reason: converted.reason === 'MISSING_EQUIVALENCY' ? 'needs_equivalency' : 'incomplete' };
  }
  return converted.canonical > 0 ? { ok: true, canonical: converted.canonical } : { ok: false, reason: 'incomplete' };
}

export type EnteredPriceInput = {
  /** Which field the manager typed: the whole-pack price or the price per kg/l/piece. */
  source: EnteredPriceSource;
  /** The price exactly as typed, integer cents, on the VAT basis given below. */
  amountCents: number;
  includesVat: boolean;
  /** Purchase VAT in basis points (2000 = 20%); null = unknown. */
  vatRateBps: number | null;
  pack: EnteredPack | null;
  dimension: Dimension;
  anchors?: UomAnchors | null;
};

export type ResolvedPrice = {
  /** Active costing price per kg / litre / piece, excl. VAT. */
  netUnitCents: number;
  /** Whole-pack price excl. VAT; null when the pack can't be priced (see `packIssue`). */
  netPackCents: number | null;
  /** Why `netPackCents` is null. Only ever set for a typed price per unit. */
  packIssue: 'incomplete' | 'needs_equivalency' | null;
};

export type PriceResolution =
  | { ok: true; value: ResolvedPrice }
  | { ok: false; reason: 'invalid_amount' | 'vat_rate_required' | 'pack_required' | 'needs_equivalency' };

export function resolveEnteredPrice(input: EnteredPriceInput): PriceResolution {
  if (!Number.isFinite(input.amountCents) || input.amountCents < 0) {
    return { ok: false, reason: 'invalid_amount' };
  }

  let divisor = 1;
  if (input.includesVat) {
    if (input.vatRateBps == null || !Number.isFinite(input.vatRateBps) || input.vatRateBps < 0) {
      return { ok: false, reason: 'vat_rate_required' };
    }
    divisor = 1 + input.vatRateBps / 10_000;
  }
  const exactNet = input.amountCents / divisor;
  const priceUnitSize = CANONICAL_PER_PRICE_UNIT[input.dimension];
  const quantity = packCanonicalQuantity(input.pack, input.dimension, input.anchors ?? null);

  if (input.source === 'unit') {
    const netUnitCents = Math.round(exactNet);
    if (!quantity.ok) {
      return { ok: true, value: { netUnitCents, netPackCents: null, packIssue: quantity.reason } };
    }
    return {
      ok: true,
      value: {
        netUnitCents,
        netPackCents: Math.round((exactNet * quantity.canonical) / priceUnitSize),
        packIssue: null,
      },
    };
  }

  if (!quantity.ok) {
    return { ok: false, reason: quantity.reason === 'incomplete' ? 'pack_required' : 'needs_equivalency' };
  }
  const netPackCents = Math.round(exactNet);
  return {
    ok: true,
    value: {
      netUnitCents: Math.round((netPackCents * priceUnitSize) / quantity.canonical),
      netPackCents,
      packIssue: null,
    },
  };
}
