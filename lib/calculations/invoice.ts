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

export type InvoiceSummaryInput = {
  status: 'draft' | 'issued' | 'paid' | 'void';
  totalCents: number;
  /** Bare 'YYYY-MM-DD' due date, or null. Only flags overdue ISSUED invoices. */
  dueDate: string | null;
};

export type InvoiceSummary = {
  /** Σ totals of ISSUED (not yet paid) invoices — accounts receivable. */
  outstandingCents: number;
  /** Σ totals of issued invoices already past their due date (subset of above). */
  overdueCents: number;
  draftCount: number;
  issuedCount: number;
  paidCount: number;
};

/**
 * At-a-glance accounts-receivable summary for the dashboard. "Outstanding" sums
 * ISSUED (unpaid) invoices; "overdue" is the subset whose due date is before
 * `today`. Dates are bare 'YYYY-MM-DD' strings compared lexicographically (same
 * tz-free approach as the finance buckets). Draft and void never count as money.
 */
export function invoiceSummary(
  invoices: InvoiceSummaryInput[],
  today: string,
): InvoiceSummary {
  let outstandingCents = 0;
  let overdueCents = 0;
  let draftCount = 0;
  let issuedCount = 0;
  let paidCount = 0;

  for (const inv of invoices) {
    switch (inv.status) {
      case 'draft':
        draftCount += 1;
        break;
      case 'issued':
        issuedCount += 1;
        outstandingCents += inv.totalCents;
        if (inv.dueDate != null && inv.dueDate < today) {
          overdueCents += inv.totalCents;
        }
        break;
      case 'paid':
        paidCount += 1;
        break;
      // 'void' is ignored — it is neither receivable nor a sale.
    }
  }

  return { outstandingCents, overdueCents, draftCount, issuedCount, paidCount };
}
