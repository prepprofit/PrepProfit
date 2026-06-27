/**
 * Quantity-TEXT parsing — turn a free-text quantity the way a chef WROTE it
 * ("1/2", "1 1/2", "½", "1½", "0.75", "2,5") into a positive number. Used by the AI
 * photo-extraction draft (Sprint 4.7 improvement): the vision model returns the raw
 * `quantityText` exactly as seen plus a best-effort numeric `quantityValue`, and the
 * server NEVER trusts the model's arithmetic — it re-parses the text here so a
 * fraction the model mis-converted (or skipped) still becomes the right number, and
 * an unparseable value keeps the line visible as `needs_review` rather than vanishing.
 *
 * Pure and dependency-free: fully unit-testable from fixtures. The result is a value
 * in the chef's WRITTEN unit (e.g. "1/2" of a cup) — canonicalization to g/ml/count
 * is the caller's job via `toCanonical(value, unit)`.
 */

export type ParseQuantityTextResult =
  | { value: number }
  | { error: 'INVALID_NUMBER' };

/** Unicode vulgar-fraction characters → their decimal value. */
const VULGAR_FRACTIONS: Record<string, number> = {
  '½': 1 / 2,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '¼': 1 / 4,
  '¾': 3 / 4,
  '⅕': 1 / 5,
  '⅖': 2 / 5,
  '⅗': 3 / 5,
  '⅘': 4 / 5,
  '⅙': 1 / 6,
  '⅚': 5 / 6,
  '⅐': 1 / 7,
  '⅛': 1 / 8,
  '⅜': 3 / 8,
  '⅝': 5 / 8,
  '⅞': 7 / 8,
  '⅑': 1 / 9,
  '⅒': 1 / 10,
};

/** A positive, finite result or the shared INVALID_NUMBER error. */
const ok = (value: number): ParseQuantityTextResult =>
  Number.isFinite(value) && value > 0 ? { value } : { error: 'INVALID_NUMBER' };

/**
 * Parse a written quantity into a positive number, or `INVALID_NUMBER`. Accepts:
 * plain integers/decimals (dot or comma), ASCII fractions (`3/4`), mixed numbers
 * (`1 1/2`), Unicode vulgar fractions (`½`), and a whole number fused with a vulgar
 * fraction (`1½` / `1 ½`). Zero, negatives, and anything else are `INVALID_NUMBER`
 * (the caller keeps the line for review, never guesses).
 */
export function parseQuantityText(raw: string): ParseQuantityTextResult {
  const s = raw.trim();
  if (s === '') return { error: 'INVALID_NUMBER' };

  // A trailing Unicode vulgar fraction, optionally after a whole number ("1½", "1 ½", "½").
  const last = s[s.length - 1]!;
  if (last in VULGAR_FRACTIONS) {
    const frac = VULGAR_FRACTIONS[last]!;
    const whole = s.slice(0, -1).trim();
    if (whole === '') return ok(frac);
    if (!/^\d+$/.test(whole)) return { error: 'INVALID_NUMBER' };
    return ok(Number(whole) + frac);
  }

  // Mixed number: "1 1/2".
  const mixed = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) {
    const denom = Number(mixed[3]);
    if (denom === 0) return { error: 'INVALID_NUMBER' };
    return ok(Number(mixed[1]) + Number(mixed[2]) / denom);
  }

  // Simple fraction: "3/4".
  const frac = s.match(/^(\d+)\/(\d+)$/);
  if (frac) {
    const denom = Number(frac[2]);
    if (denom === 0) return { error: 'INVALID_NUMBER' };
    return ok(Number(frac[1]) / denom);
  }

  // Plain integer/decimal — dot or comma as the decimal separator.
  if (/^\d+([.,]\d+)?$/.test(s)) return ok(Number(s.replace(',', '.')));

  return { error: 'INVALID_NUMBER' };
}
