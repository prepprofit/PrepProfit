import { lineTotals } from '@/lib/calculations/invoice';
import type { Invoice, InvoiceItem } from '@/lib/db/schema';
import type { InvoiceDocumentData, DocumentLine } from './types';
import { blankToNull, buildSellerIdentity, type SellerSettings } from './seller';

/**
 * Pure mapping from stored invoice rows → the document view-model (Sprint 3.5A).
 * No I/O: the caller (PDF route / print page) loads the data inside `withOrg` and
 * passes it here. Reuses the shared `lineTotals` so each line's net/tax/gross is
 * rounded exactly as on screen; the invoice's FROZEN subtotal/tax/total are used
 * verbatim (never recomputed) so the document is immutable and reproducible.
 */

/** Re-exported for callers that still import the seller shape from here. */
export type { SellerSettings };

export function buildInvoiceDocumentData(
  detail: { invoice: Invoice; items: InvoiceItem[] },
  settings: SellerSettings,
  /** Clerk organization name, used when `businessName` is blank. */
  orgNameFallback: string | null,
): InvoiceDocumentData {
  const { invoice, items } = detail;

  const lines: DocumentLine[] = items.map((it) => {
    const quantity = Number(it.quantity);
    const taxRatePercent = Number(it.taxRate);
    const { netCents, taxCents, grossCents } = lineTotals({
      quantity,
      unitPriceCents: it.unitPriceCents,
      taxRate: taxRatePercent,
    });
    return {
      description: it.description,
      quantity,
      unitPriceCents: it.unitPriceCents,
      taxRatePercent,
      netCents,
      taxCents,
      grossCents,
    };
  });

  return {
    seller: buildSellerIdentity(settings, orgNameFallback),
    customer: {
      name: blankToNull(invoice.customerName),
      taxId: blankToNull(invoice.customerTaxId),
      address: blankToNull(invoice.customerAddress),
      email: blankToNull(invoice.customerEmail),
    },
    number: invoice.number,
    status: invoice.status,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    notes: blankToNull(invoice.notes),
    currency: settings.currency,
    lines,
    // FROZEN at issue — used verbatim, never recomputed.
    subtotalCents: invoice.subtotalCents,
    taxCents: invoice.taxCents,
    totalCents: invoice.totalCents,
  };
}

/**
 * Filename stem for a downloaded invoice: the invoice number if issued, else a
 * stable `draft-<id>` so draft previews never collide. No extension.
 */
export function invoiceDocumentFilename(
  invoice: Pick<Invoice, 'id' | 'number'>,
): string {
  const base = invoice.number ?? `draft-${invoice.id}`;
  // Keep it filesystem/header safe.
  return base.replace(/[^A-Za-z0-9._-]+/g, '_');
}
