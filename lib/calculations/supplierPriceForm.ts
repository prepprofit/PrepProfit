import { CANONICAL_PER_PRICE_UNIT } from '@/lib/calculations/recipeCost';
import { toCanonical, type Dimension, type Unit } from '@/lib/units';

/**
 * Pure maths + rules behind the ingredient supplier editor. Everything here works
 * on ONE VAT basis at a time (both prices excl. VAT, or both incl. VAT): converting
 * between the pack price and the price per kg / litre / piece never adds or removes
 * VAT, so an unknown VAT rate never blocks it. VAT is applied exactly once, on the
 * server, when an incl.-VAT price is stored as the net whole-pack price.
 */

export type PriceSource = 'pack' | 'unit';

export type PackShape = {
  /** Inner units in one purchase (a 4 × 1.65 kg case → 4). */
  unitsPerPack: number;
  /** Size of ONE inner unit, in `packUnit`. */
  packSize: number;
  packUnit: Unit;
  /** The ingredient's dimension — the "unit" price is per kg / litre / piece. */
  dimension: Dimension;
};

/** Canonical grams / ml / pieces in one purchase, or null when it isn't positive. */
function canonicalTotal(pack: PackShape): number | null {
  if (!(pack.unitsPerPack > 0) || !(pack.packSize > 0)) return null;
  const total = toCanonical(pack.unitsPerPack * pack.packSize, pack.packUnit);
  return Number.isFinite(total) && total > 0 ? total : null;
}

/**
 * The other price, on the same VAT basis, from the one the user entered:
 *   pack → unit: €20 for 2.5 kg → €8/kg
 *   unit → pack: €8/kg × 500 g  → €4
 * Integer cents in, integer cents out; null when the pack is incomplete.
 */
export function derivePriceCents(source: PriceSource, sourceCents: number, pack: PackShape): number | null {
  if (!Number.isFinite(sourceCents) || sourceCents < 0) return null;
  const total = canonicalTotal(pack);
  if (total === null) return null;
  const perPricedUnit = CANONICAL_PER_PRICE_UNIT[pack.dimension];
  return source === 'pack'
    ? Math.round((sourceCents * perPricedUnit) / total)
    : Math.round((sourceCents * total) / perPricedUnit);
}

export type VatSuggestionSource = 'entry' | 'ingredient' | 'band' | 'business';

/**
 * The VAT rate the editor pre-fills, most specific first: this ingredient ⇄
 * supplier entry, the ingredient's own rate, the ingredient's chosen VAT band, then
 * the business's configured default purchase VAT. None → null (VAT stays optional).
 * Mirrors `resolvePurchaseVatBps` on the server.
 */
export function suggestPurchaseVat(sources: {
  entryBps: number | null;
  ingredientBps: number | null;
  bandBps: number | null;
  businessBps: number | null;
}): { bps: number; source: VatSuggestionSource } | null {
  if (sources.entryBps != null) return { bps: sources.entryBps, source: 'entry' };
  if (sources.ingredientBps != null) return { bps: sources.ingredientBps, source: 'ingredient' };
  if (sources.bandBps != null) return { bps: sources.bandBps, source: 'band' };
  if (sources.businessBps != null) return { bps: sources.businessBps, source: 'business' };
  return null;
}

/** A positive decimal typed with a comma or point ("2,5", "0.5"); null otherwise. */
export function parsePositiveDecimal(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** A whole count ≥ 1 ("4"); null otherwise. */
export function parseWholeCount(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 1 && value <= 100_000 ? value : null;
}

/** Money typed as "20", "19,90" or "8.5" → integer cents (≥ 0); null otherwise. */
export function parseMoneyText(text: string): number | null {
  const trimmed = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(trimmed)) return null;
  const cents = Math.round(Number(trimmed) * 100);
  return Number.isFinite(cents) && cents >= 0 && cents <= 100_000_000 ? cents : null;
}
