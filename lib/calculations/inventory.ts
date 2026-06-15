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
