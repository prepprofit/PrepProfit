import { packCanonicalQuantity, type EnteredPack, type EnteredPriceSource } from '@/lib/calculations/ingredientPriceEntry';
import { CANONICAL_PER_PRICE_UNIT } from '@/lib/calculations/recipeCost';
import type { UomAnchors } from '@/lib/calculations/uom';
import { parseMoneyText } from '@/lib/calculations/supplierPriceForm';
import { centsToAmountInput } from '@/lib/format/money';
import type { Dimension } from '@/lib/units';

/**
 * The state machine behind the ingredient editor's two linked price fields (pack price
 * and price per kg / litre / piece) and its single "Prices entered: excl./incl. VAT"
 * control. Pure, so every rule is unit-tested without a browser.
 *
 * Only ONE field is ever the source — the last one the manager typed. The other is
 * calculated from it on the SAME VAT basis (VAT cancels out of a pack ↔ unit
 * conversion, so a missing rate never blocks it). `netCents` remembers the exact
 * excl.-VAT amount of the source, which is what lets the basis switch convert the
 * numbers without drifting and without ever relabelling an unchanged figure.
 */

export type PriceEditState = {
  source: EnteredPriceSource;
  /** The source field as typed, on the current VAT basis. */
  text: string;
  /** Exact excl.-VAT cents of the source amount; null while unknowable. */
  netCents: number | null;
  /** True when `text` is blank ONLY because the incl.-VAT figure needs a VAT rate. */
  textStale: boolean;
  includesVat: boolean;
};

export const EMPTY_PRICE_STATE: PriceEditState = {
  source: 'pack',
  text: '',
  netCents: null,
  textStale: false,
  includesVat: false,
};

/** Excl.-VAT cents (exact) behind a typed amount, or null when it can't be known. */
function netFromText(text: string, includesVat: boolean, vatBps: number | null): number | null {
  const cents = parseMoneyText(text);
  if (cents === null) return null;
  if (!includesVat) return cents;
  return vatBps === null ? null : cents / (1 + vatBps / 10_000);
}

/** Opens the editor on a known excl.-VAT amount, shown on the chosen basis. */
export function initPriceState(input: {
  source: EnteredPriceSource;
  netCents: number | null;
  includesVat: boolean;
  vatBps: number | null;
}): PriceEditState {
  if (input.netCents === null) return { ...EMPTY_PRICE_STATE, source: input.source, includesVat: input.includesVat };
  if (!input.includesVat) {
    return {
      source: input.source,
      text: centsToAmountInput(Math.round(input.netCents)),
      netCents: input.netCents,
      textStale: false,
      includesVat: false,
    };
  }
  if (input.vatBps === null) {
    return { source: input.source, text: '', netCents: input.netCents, textStale: true, includesVat: true };
  }
  return {
    source: input.source,
    text: centsToAmountInput(Math.round(input.netCents * (1 + input.vatBps / 10_000))),
    netCents: input.netCents,
    textStale: false,
    includesVat: true,
  };
}

/** The manager typed into one of the two price fields. */
export function editPrice(
  state: PriceEditState,
  source: EnteredPriceSource,
  text: string,
  vatBps: number | null,
): PriceEditState {
  return {
    ...state,
    source,
    text,
    textStale: false,
    netCents: netFromText(text, state.includesVat, vatBps),
  };
}

export type BasisChange =
  | { ok: true; state: PriceEditState }
  | { ok: false; reason: 'vat_rate_required' };

/**
 * Switch the "Prices entered" basis, converting known amounts so the underlying net
 * cost is preserved. Going to incl. VAT with no rate keeps the net and blanks the
 * figure until a rate exists; leaving incl. VAT while the net is unknowable is
 * refused (the typed gross can't be converted honestly).
 */
export function setPriceBasis(state: PriceEditState, includesVat: boolean, vatBps: number | null): BasisChange {
  if (state.includesVat === includesVat) return { ok: true, state };

  if (includesVat) {
    if (state.netCents === null) return { ok: true, state: { ...state, includesVat: true } };
    if (vatBps === null) return { ok: true, state: { ...state, includesVat: true, text: '', textStale: true } };
    return {
      ok: true,
      state: {
        ...state,
        includesVat: true,
        text: centsToAmountInput(Math.round(state.netCents * (1 + vatBps / 10_000))),
        textStale: false,
      },
    };
  }

  if (state.netCents === null) {
    // A blank or unparseable field carries nothing to convert; a typed gross with an
    // unknown rate cannot be converted, so the basis stays where it is.
    return state.text.trim() === '' && !state.textStale
      ? { ok: true, state: { ...state, includesVat: false } }
      : { ok: false, reason: 'vat_rate_required' };
  }
  return {
    ok: true,
    state: { ...state, includesVat: false, text: centsToAmountInput(Math.round(state.netCents)), textStale: false },
  };
}

/** The VAT rate changed: re-derive the net from the typed gross, or fill a stale field. */
export function applyVatRate(state: PriceEditState, vatBps: number | null): PriceEditState {
  if (!state.includesVat) return state;
  if (state.textStale) {
    if (vatBps === null || state.netCents === null) return state;
    return {
      ...state,
      text: centsToAmountInput(Math.round(state.netCents * (1 + vatBps / 10_000))),
      textStale: false,
    };
  }
  return { ...state, netCents: netFromText(state.text, true, vatBps) };
}

export type LinkedPrices = {
  /** Text to show in the pack-price field ('' when unknown). */
  packText: string;
  /** Text to show in the price-per-unit field ('' when unknown). */
  unitText: string;
  /** Which field the calculation came from. */
  source: EnteredPriceSource;
  /** True when the OTHER field could not be calculated because the pack is unusable. */
  packIssue: 'incomplete' | 'needs_equivalency' | null;
};

/** Both field values: the typed one as-is, the other calculated on the same basis. */
export function linkedPrices(
  state: PriceEditState,
  pack: EnteredPack | null,
  dimension: Dimension,
  anchors: UomAnchors | null,
): LinkedPrices {
  const quantity = packCanonicalQuantity(pack, dimension, anchors);
  const sourceCents = parseMoneyText(state.text);
  const size = CANONICAL_PER_PRICE_UNIT[dimension];

  let otherText = '';
  if (sourceCents !== null && quantity.ok) {
    const other =
      state.source === 'pack'
        ? Math.round((sourceCents * size) / quantity.canonical)
        : Math.round((sourceCents * quantity.canonical) / size);
    otherText = centsToAmountInput(other);
  }
  const packIssue = quantity.ok ? null : quantity.reason;
  return state.source === 'pack'
    ? { packText: state.text, unitText: otherText, source: 'pack', packIssue }
    : { packText: otherText, unitText: state.text, source: 'unit', packIssue };
}
