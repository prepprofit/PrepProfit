import type {
  PurchaseOrder,
  PurchaseOrderItem,
} from '@/lib/db/schema';
import type { Dimension } from '@/lib/units';
import type {
  PurchaseOrderDocumentData,
  PurchaseOrderDocumentLine,
} from './types';
import { blankToNull, buildSellerIdentity, type SellerSettings } from './seller';

/**
 * Pure mapping from stored purchase-order rows → the document view-model
 * (Sprint 8a). No I/O: the caller (PDF route / print page) loads the data inside
 * `withOrg` and passes it here.
 *
 * Snapshot rule (F3): for a SENT/CANCELLED PO the FROZEN columns are used verbatim
 * (supplier_* + per-line ingredient_name/dimension), so the document is immutable.
 * For a DRAFT the snapshot is empty, so the caller supplies the LIVE supplier + live
 * ingredient {name, dimension} per line; the draft renders with a DRAFT watermark.
 */

/** Re-exported for callers that import the seller shape from here. */
export type { SellerSettings };

/** Live data needed to render a DRAFT (ignored for sent/cancelled). */
export type PurchaseOrderLiveContext = {
  supplier: {
    name: string;
    taxId: string | null;
    address: string | null;
    email: string | null;
    phone: string | null;
  } | null;
  /** ingredientId → live name/dimension, for draft lines (no frozen snapshot yet). */
  ingredientsById: Map<string, { name: string; dimension: Dimension }>;
};

/** Presentation form of a PO number, e.g. 7 → 'PO-0007'. Never the stored key. */
export function formatPoNumber(n: number): string {
  return `PO-${String(n).padStart(4, '0')}`;
}

export function buildPurchaseOrderDocumentData(
  detail: { order: PurchaseOrder; items: PurchaseOrderItem[] },
  settings: SellerSettings,
  /** Clerk organization name, used when `businessName` is blank. */
  orgNameFallback: string | null,
  live: PurchaseOrderLiveContext,
): PurchaseOrderDocumentData {
  const { order, items } = detail;
  const isDraft = order.status === 'draft';

  const lines: PurchaseOrderDocumentLine[] = items.map((it) => {
    const liveIng = it.ingredientId ? live.ingredientsById.get(it.ingredientId) : undefined;
    // Frozen snapshot wins (sent/cancelled); fall back to live for a draft.
    const name = it.ingredientName ?? liveIng?.name ?? '';
    const dimension: Dimension = it.dimension ?? liveIng?.dimension ?? 'weight';
    return {
      name,
      dimension,
      quantity: Number(it.quantity),
      unitCostCents: it.unitCostCents,
      lineTotalCents: it.lineTotalCents,
    };
  });

  const supplier = isDraft
    ? {
        name: blankToNull(live.supplier?.name ?? null),
        taxId: blankToNull(live.supplier?.taxId ?? null),
        address: blankToNull(live.supplier?.address ?? null),
        email: blankToNull(live.supplier?.email ?? null),
        phone: blankToNull(live.supplier?.phone ?? null),
      }
    : {
        name: blankToNull(order.supplierName),
        taxId: blankToNull(order.supplierTaxId),
        address: blankToNull(order.supplierAddress),
        email: blankToNull(order.supplierEmail),
        phone: blankToNull(order.supplierPhone),
      };

  return {
    seller: buildSellerIdentity(settings, orgNameFallback),
    supplier,
    number: formatPoNumber(order.number),
    status: order.status,
    isDraft,
    orderDate: order.orderDate,
    expectedDate: order.expectedDate,
    notes: blankToNull(order.notes),
    // The PO froze its own currency at create — use it, not the live org setting.
    currency: order.currencyCode,
    lines,
    subtotalCents: order.subtotalCents,
    totalCents: order.totalCents,
  };
}

/** Filename stem for a downloaded PO (e.g. 'PO-0007'). No extension. */
export function purchaseOrderDocumentFilename(
  order: Pick<PurchaseOrder, 'number'>,
): string {
  return formatPoNumber(order.number).replace(/[^A-Za-z0-9._-]+/g, '_');
}
