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
