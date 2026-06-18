/**
 * Inventory helpers. Pure functions; quantities are canonical (g / ml / count).
 */

/** True when stock is at or below the configured low-stock threshold. */
export function isLowStock(
  stockCanonical: number,
  thresholdCanonical: number | null,
): boolean {
  if (thresholdCanonical == null) return false;
  return stockCanonical <= thresholdCanonical;
}

export type StockItem = {
  /** Current stock in canonical units (g / ml / count). */
  stockCanonical: number;
  /** Low-stock threshold in canonical units, or null when unset. */
  thresholdCanonical: number | null;
};

/**
 * The items at or below their low-stock threshold (reuses {@link isLowStock}),
 * most-depleted first (largest shortfall below the threshold). Items without a
 * threshold are never low. Pure — the caller parses the numeric DB values first.
 * Generic so callers keep their own extra fields (id, name, dimension…) typed.
 */
export function selectLowStock<T extends StockItem>(items: T[]): T[] {
  return items
    .filter((i) => isLowStock(i.stockCanonical, i.thresholdCanonical))
    .sort(
      (a, b) =>
        (b.thresholdCanonical as number) -
        b.stockCanonical -
        ((a.thresholdCanonical as number) - a.stockCanonical),
    );
}
