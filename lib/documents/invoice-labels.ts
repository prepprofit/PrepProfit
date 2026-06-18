import type { InvoiceDocumentLabels } from './types';

/**
 * Build the localized label set for an invoice document from a next-intl
 * translator scoped to the `invoiceDocument` namespace. Shared by the PDF route
 * and the HTML print page so both render identical wording.
 */
export function buildInvoiceLabels(
  t: (key: string) => string,
): InvoiceDocumentLabels {
  return {
    title: t('title'),
    from: t('from'),
    billTo: t('billTo'),
    invoiceNo: t('invoiceNo'),
    issued: t('issued'),
    due: t('due'),
    taxId: t('taxId'),
    description: t('description'),
    quantity: t('quantity'),
    unitPrice: t('unitPrice'),
    taxRate: t('taxRate'),
    lineTotal: t('lineTotal'),
    subtotal: t('subtotal'),
    tax: t('tax'),
    total: t('total'),
    notes: t('notes'),
    status: {
      draft: t('status.draft'),
      issued: t('status.issued'),
      paid: t('status.paid'),
      void: t('status.void'),
    },
  };
}
