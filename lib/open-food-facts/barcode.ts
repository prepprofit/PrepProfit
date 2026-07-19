/**
 * Barcode validation & sanitization for the Open Food Facts integration
 * (plan §8). A barcode is a STRING from UI to database — NEVER a JavaScript
 * number or a PostgreSQL integer (leading zeroes are significant and float
 * precision would corrupt long GTINs).
 *
 * This module only sanitizes and check-digit-validates the user input; the
 * canonical stored code is the one the provider returns for the lookup.
 */

/** GTIN lengths PrepProfit accepts initially: EAN-8, UPC-A, EAN-13, GTIN-14. */
const SUPPORTED_LENGTHS = new Set([8, 12, 13, 14]);

/** Visual separators we explicitly strip; anything else non-digit is rejected. */
const SEPARATORS = /[\s-]/g;

export type BarcodeResult =
  | { ok: true; code: string }
  | { ok: false; reason: 'EMPTY' | 'NON_DIGIT' | 'LENGTH' | 'CHECK_DIGIT' };

/**
 * Standard GTIN check-digit test — works for EAN-8, UPC-A, EAN-13 and GTIN-14.
 * Weight the data digits 3,1,3,1… from the right of the payload; the check
 * digit is `(10 - (sum % 10)) % 10`.
 */
export function gtinCheckDigitValid(code: string): boolean {
  const digits = [...code].map((c) => c.charCodeAt(0) - 48);
  const check = digits.pop();
  if (check === undefined) return false;
  let sum = 0;
  for (let i = digits.length - 1, weightIsThree = true; i >= 0; i -= 1) {
    sum += digits[i]! * (weightIsThree ? 3 : 1);
    weightIsThree = !weightIsThree;
  }
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * Sanitize + validate a user-entered barcode (plan §8):
 * trim → strip accepted separators → reject non-digits → enforce a supported
 * length → validate the check digit → return the string with leading zeroes
 * preserved.
 */
export function normalizeBarcode(raw: string): BarcodeResult {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, reason: 'EMPTY' };
  const stripped = trimmed.replace(SEPARATORS, '');
  if (stripped === '') return { ok: false, reason: 'EMPTY' };
  if (!/^\d+$/.test(stripped)) return { ok: false, reason: 'NON_DIGIT' };
  if (!SUPPORTED_LENGTHS.has(stripped.length)) return { ok: false, reason: 'LENGTH' };
  if (!gtinCheckDigitValid(stripped)) return { ok: false, reason: 'CHECK_DIGIT' };
  return { ok: true, code: stripped };
}
