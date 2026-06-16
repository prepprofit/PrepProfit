/**
 * Money formatting — the single edge where integer cents become a human-readable
 * string, and where user input becomes integer cents.
 *
 * CLAUDE.md: monetary values are ALWAYS stored as integer cents, never float.
 * One currency per organization, with NO conversion. Every monetary value shown
 * in the UI goes through {@link formatMoney}.
 */

/**
 * Format integer cents as a localized currency string.
 * `formatMoney(1234, 'EUR')` → `"€12.34"`. Fraction digits follow the currency
 * (e.g. JPY shows none); the locale controls grouping and symbol placement.
 */
export function formatMoney(
  cents: number,
  currency: string,
  locale = 'en',
): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).format(cents / 100);
}

/**
 * Compact currency for chart axes/labels: `450000` → `"€4.5K"`, `12000` → `"€120"`.
 * Drops cents and uses compact notation so dense axes stay legible; tooltips and
 * KPIs still use the precise {@link formatMoney}.
 */
export function formatMoneyCompact(
  cents: number,
  currency: string,
  locale = 'en',
): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(cents / 100);
}

/** Integer cents → a plain, editable major-unit string. `1234` → `"12.34"`. */
export function centsToAmountInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Parse a user-entered amount in major units into integer cents.
 * Tolerates currency symbols/whitespace and both decimal conventions:
 *   "12.34" → 1234, "12,34" → 1234, "1,234.56" → 123456, "1.234,56" → 123456.
 * When both `.` and `,` appear, the last one is treated as the decimal
 * separator. Empty or unparseable input returns 0. Rounds to the nearest cent.
 */
export function parseMoneyToCents(input: string): number {
  const trimmed = input.trim();
  if (trimmed === '') return 0;

  // Keep only digits, separators and a leading sign.
  let s = trimmed.replace(/[^\d.,-]/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  if (lastComma !== -1 && lastDot !== -1) {
    const decimalSep = lastComma > lastDot ? ',' : '.';
    const thousandSep = decimalSep === ',' ? '.' : ',';
    s = s.split(thousandSep).join('').replace(decimalSep, '.');
  } else if (lastComma !== -1) {
    // Only commas present: treat the comma as the decimal separator.
    s = s.replace(',', '.');
  }

  const value = Number(s);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}
