/**
 * Invoice totals — pure function, no I/O. Money is in integer cents (CLAUDE.md).
 *
 * VAT is modelled PER LINE (a food invoice mixes standard and reduced rates):
 *   lineNet   = round(quantity × unitPriceCents)
 *   lineTax   = round(lineNet × taxRate / 100)
 *   lineGross = lineNet + lineTax
 * Rounding happens PER LINE, then the lines are summed — so the printed per-line
 * figures always reconcile with the invoice total (no penny drift from summing
 * un-rounded fractions). `taxRate` is a percentage (e.g. 23 for 23%), not money.
 *
 * These totals are computed once and FROZEN onto the invoice row at issue
 * (lib/data/invoices.ts), so the document is immutable and reproducible.
 */

export type InvoiceLineInput = {
  /** Units billed (may be fractional, e.g. 1.5 kg). */
  quantity: number;
  /** Net unit price in integer cents. */
  unitPriceCents: number;
  /** VAT rate as a percentage (0..100). */
  taxRate: number;
};

export type InvoiceLineTotals = {
  /** Net line amount (quantity × unit price), in cents. */
  netCents: number;
  /** VAT on the net line amount, in cents. */
  taxCents: number;
  /** Net + tax, in cents. */
  grossCents: number;
};

export type InvoiceTotals = {
  /** Sum of line nets (the invoice subtotal), in cents. */
  subtotalCents: number;
  /** Sum of line taxes, in cents. */
  taxCents: number;
  /** Subtotal + tax (the amount due), in cents. */
  totalCents: number;
};

/** Net / tax / gross for one line, each independently rounded to whole cents. */
export function lineTotals(line: InvoiceLineInput): InvoiceLineTotals {
  const netCents = Math.round(line.quantity * line.unitPriceCents);
  const taxCents = Math.round((netCents * line.taxRate) / 100);
  return { netCents, taxCents, grossCents: netCents + taxCents };
}

/** Invoice subtotal / tax / total = the rounded line figures, summed. */
export function invoiceTotals(lines: InvoiceLineInput[]): InvoiceTotals {
  return lines.reduce<InvoiceTotals>(
    (acc, line) => {
      const { netCents, taxCents } = lineTotals(line);
      return {
        subtotalCents: acc.subtotalCents + netCents,
        taxCents: acc.taxCents + taxCents,
        totalCents: acc.totalCents + netCents + taxCents,
      };
    },
    { subtotalCents: 0, taxCents: 0, totalCents: 0 },
  );
}
