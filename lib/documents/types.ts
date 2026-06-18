import type { InvoiceStatus } from '@/lib/db/schema';

/**
 * Shared document view-models (Sprint 3.5A). Both the PDF renderer
 * (lib/documents/invoice-pdf.tsx) and the HTML print view
 * (app/(app)/invoices/[id]/print) consume the SAME `InvoiceDocumentData`, built
 * once by the pure `buildInvoiceDocumentData` (lib/documents/invoice-data.ts), so
 * the two surfaces can never drift.
 *
 * All money is integer cents; `taxRatePercent` is a percentage (e.g. 23). Line
 * net/tax/gross are computed with the shared `lineTotals` so the printed figures
 * reconcile with the invoice's frozen totals.
 */

/** The business issuing the invoice (the "From" block). */
export type SellerIdentity = {
  /** Resolved display name: org settings `businessName`, else the Clerk org name. */
  name: string;
  address: string | null;
  taxId: string | null;
  email: string | null;
  /** https-only URL (validated in lib/validation/org-settings.ts), or null. */
  logoUrl: string | null;
};

/** The frozen customer snapshot (the "Bill to" block). */
export type CustomerBlock = {
  name: string | null;
  taxId: string | null;
  address: string | null;
  email: string | null;
};

/** One rendered invoice line, with its independently-rounded amounts in cents. */
export type DocumentLine = {
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRatePercent: number;
  netCents: number;
  taxCents: number;
  grossCents: number;
};

/**
 * Localized strings for an invoice document. Resolved by the caller (route / print
 * page) via next-intl and passed in, so the PDF component and print view stay free
 * of the i18n runtime and render identically.
 */
export type InvoiceDocumentLabels = {
  title: string;
  from: string;
  billTo: string;
  invoiceNo: string;
  issued: string;
  due: string;
  taxId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  lineTotal: string;
  subtotal: string;
  tax: string;
  total: string;
  notes: string;
  status: Record<InvoiceStatus, string>;
};

/** Everything a generated invoice document needs, with no DB/I/O coupling. */
export type InvoiceDocumentData = {
  seller: SellerIdentity;
  customer: CustomerBlock;
  /** Formatted invoice number, or null while still a draft. */
  number: string | null;
  status: InvoiceStatus;
  /** Bare 'YYYY-MM-DD' strings (or null). */
  issueDate: string | null;
  dueDate: string | null;
  notes: string | null;
  /** ISO-4217 currency code used to format every amount. */
  currency: string;
  lines: DocumentLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
};
