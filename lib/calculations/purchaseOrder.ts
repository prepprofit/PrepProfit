import type { Dimension } from '@/lib/units';
import { CANONICAL_PER_PRICE_UNIT } from '@/lib/calculations/recipeCost';

/**
 * Purchase-order line + total math (Sprint 8a). Pure, no I/O.
 *
 * A PO line orders an ingredient at a NEGOTIATED `unitCostCents` (cost per priced
 * unit — per kg / litre / piece) for a `quantity` in CANONICAL units (g / ml /
 * count). The line total reuses the recipeCost convention so a PO and a recipe
 * never disagree on what a quantity costs:
 *   weight → unitCostCents × grams / 1000
 *   volume → unitCostCents × millilitres / 1000
 *   count  → unitCostCents × pieces
 * Money is integer cents; the line total is rounded half-up to whole cents.
 */
export type PurchaseOrderLine = {
  dimension: Dimension;
  /** Negotiated cost per priced unit (per kg / litre / piece), integer cents. */
  unitCostCents: number;
  /** Canonical amount ordered: grams (weight), millilitres (volume), or count. */
  quantity: number;
};

/** Whole-cent total for a single line (rounded half-up). */
export function purchaseOrderLineTotalCents(line: PurchaseOrderLine): number {
  const raw =
    (line.unitCostCents * line.quantity) /
    CANONICAL_PER_PRICE_UNIT[line.dimension];
  return Math.round(raw);
}

export type PurchaseOrderTotals = {
  /** Sum of the line totals, integer cents. */
  subtotalCents: number;
  /** v1 has no PO-level tax, so total == subtotal (kept separate for forward-compat). */
  totalCents: number;
};

/** Sum the per-line totals into the PO subtotal/total. */
export function purchaseOrderTotals(
  lines: PurchaseOrderLine[],
): PurchaseOrderTotals {
  const subtotalCents = lines.reduce(
    (sum, line) => sum + purchaseOrderLineTotalCents(line),
    0,
  );
  return { subtotalCents, totalCents: subtotalCents };
}
