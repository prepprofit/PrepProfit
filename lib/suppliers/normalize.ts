/**
 * Supplier name normalization (Sprint F6) — the SINGLE source of truth for the
 * supplier dedup key. Suppliers (Sprint 7), purchase orders (8), the backfill, and
 * the import resolver MUST all dedup on this exact key; SQL and import code must
 * call this helper, never re-implement `lower(trim(...))` inline (it would diverge).
 *
 * The key lowercases, trims, and collapses any run of Unicode whitespace to a
 * single space, so `'  ACME   Foods '` and `'acme foods'` map to the same key.
 *
 * An EMPTY result (`''`) is INVALID: a blank / whitespace-only name has no identity.
 * Callers must reject it — never create a supplier with an empty key.
 */
export function normalizeSupplierName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/gu, ' ');
}
