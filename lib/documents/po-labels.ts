import type { PurchaseOrderDocumentLabels } from './types';

/**
 * Build the localized label set for a purchase-order document from a next-intl
 * translator scoped to the `purchaseOrderDocument` namespace. Shared by the PDF
 * route and the HTML print page so both render identical wording.
 */
export function buildPurchaseOrderLabels(
  t: (key: string) => string,
): PurchaseOrderDocumentLabels {
  return {
    title: t('title'),
    from: t('from'),
    supplierTo: t('supplierTo'),
    poNo: t('poNo'),
    orderDate: t('orderDate'),
    expectedDate: t('expectedDate'),
    taxId: t('taxId'),
    phone: t('phone'),
    ingredient: t('ingredient'),
    quantity: t('quantity'),
    unitCost: t('unitCost'),
    lineTotal: t('lineTotal'),
    subtotal: t('subtotal'),
    total: t('total'),
    notes: t('notes'),
    status: {
      draft: t('status.draft'),
      sent: t('status.sent'),
      partially_received: t('status.partially_received'),
      received: t('status.received'),
      cancelled: t('status.cancelled'),
    },
    units: {
      weight: t('units.weight'),
      volume: t('units.volume'),
      count: t('units.count'),
    },
  };
}
