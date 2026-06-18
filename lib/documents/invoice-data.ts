import { lineTotals } from '@/lib/calculations/invoice';
import type { Invoice, InvoiceItem } from '@/lib/db/schema';
import type { InvoiceDocumentData, DocumentLine } from './types';

/**
 * Pure mapping from stored invoice rows → the document view-model (Sprint 3.5A).
 * No I/O: the caller (PDF route / print page) loads the data inside `withOrg` and
 * passes it here. Reuses the shared `lineTotals` so each line's net/tax/gross is
 * rounded exactly as on screen; the invoice's FROZEN subtotal/tax/total are used
 * verbatim (never recomputed) so the document is immutable and reproducible.
 */

/** The seller fields this builder reads — satisfied by both the settings row and
 * `OrgSettingsValues`. Kept narrow so the function stays pure and testable. */
export type SellerSettings = {
  currency: string;
  businessName: string | null;
  businessAddress: string | null;
  businessTaxId: string | null;
  businessEmail: string | null;
  businessLogoUrl: string | null;
};

function blankToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

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

  const sellerName =
    blankToNull(settings.businessName) ?? blankToNull(orgNameFallback) ?? '';

  return {
    seller: {
      name: sellerName,
      address: blankToNull(settings.businessAddress),
      taxId: blankToNull(settings.businessTaxId),
      email: blankToNull(settings.businessEmail),
      logoUrl: blankToNull(settings.businessLogoUrl),
    },
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
