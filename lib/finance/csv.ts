import { centsToAmountInput } from '@/lib/format/money';

/**
 * Minimal, dependency-free CSV writer (RFC 4180). The transaction export uses a
 * STABLE machine format — ISO date, dot-decimal amount, comma separator, CRLF
 * lines — so it is symmetric with the Sprint 2.5 import template (same columns).
 */

/** Quote a field iff it contains a comma, quote, or newline; double inner quotes. */
function escapeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(headers: string[], rows: string[][]): string {
  return [headers, ...rows]
    .map((cols) => cols.map(escapeField).join(','))
    .join('\r\n');
}

/** Columns for the transactions export — mirror the future import template. */
export const TRANSACTION_CSV_HEADERS = [
  'date',
  'type',
  'category',
  'recipe',
  'amount',
  'note',
] as const;

export type CsvTransactionRow = {
  /** 'YYYY-MM-DD'. */
  occurredOn: string;
  type: string;
  /** Stable category label (the row name, not the i18n display). */
  categoryName: string;
  recipeName: string | null;
  amountCents: number;
  note: string | null;
};

export function transactionsToCsv(rows: CsvTransactionRow[]): string {
  const body = rows.map((r) => [
    r.occurredOn,
    r.type,
    r.categoryName,
    r.recipeName ?? '',
    centsToAmountInput(r.amountCents),
    r.note ?? '',
  ]);
  return toCsv([...TRANSACTION_CSV_HEADERS], body);
}
