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
 * Sanitize a stem into a header/filesystem-safe download filename (no extension).
 * Same scrub as `invoiceDocumentFilename` so every generated document's
 * `Content-Disposition` is consistent and injection-safe. A blank stem falls back
 * to 'document'.
 */
export function documentFilename(stem: string): string {
  const safe = stem.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return safe === '' ? 'document' : safe;
}
