import { formatMoney } from '@/lib/format/money';

/**
 * Small formatting helpers shared by the invoice PDF and HTML print view
 * (Sprint 3.5A). `formatMoney` is re-exported so document code has a single
 * import surface.
 */
export { formatMoney };

/**
 * Format a bare 'YYYY-MM-DD' date for documents. Kept tz-free (no `new Date()`
 * parsing, which would shift the day across time zones) — the stored string is
 * already the calendar date, so we render it as-is. Returns '' for null/blank.
 */
export function formatDocDate(date: string | null | undefined): string {
  return date == null ? '' : date;
}

/**
 * Coerce a possibly-null value to a string. `@react-pdf/renderer` throws on null
 * children, so every dynamic value rendered into a `<Text>` goes through this.
 */
export function safeText(value: string | number | null | undefined): string {
  if (value == null) return '';
  return String(value);
}

/**
 * Format a canonical physical quantity (grams / millilitres / pieces) for a
 * printed document: up to 2 decimals, trailing zeros trimmed, thousands
 * separated — "2105" → "2,105", "0.5" → "0.5", "125.25" → "125.25". Kitchen
 * Scale prints canonical units directly (never kg/l-shifted) so the number on
 * the page is exactly what a kitchen scale should be zeroed to.
 */
export function formatDocumentQuantity(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * Sanitize a stem into a header/filesystem-safe download filename (no extension).
 * Same scrub as `invoiceDocumentFilename` so every generated document's
 * `Content-Disposition` is consistent and injection-safe. A blank stem falls back
 * to 'document'.
 */
export function documentFilename(stem: string): string {
  const safe = stem.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return safe === '' ? 'document' : safe;
}
