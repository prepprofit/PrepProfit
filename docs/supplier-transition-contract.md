# Supplier identity transition contract (Sprint F6)

How a free-text supplier name becomes a real supplier record without losing the
legacy `ingredients.supplier` data or breaking code that still reads it. F6 ships
**only** the dedup-key helper + this contract; the `suppliers` table, the dual-write
code, and the backfill are **Sprint 7** (they need the table).

## The dedup key — the single source of truth

`normalizeSupplierName(name)` (`lib/suppliers/normalize.ts`) is the ONE key everyone
dedups on. It:

- `.toLowerCase()`, `.trim()`, and **collapses any run of Unicode whitespace to a
  single space** (`/\s+/gu`), so `'  ACME   Foods '` and `'acme foods'` map to the
  same key;
- returns `''` for a blank / whitespace-only name — **an empty key is INVALID**;
  callers must reject it (never create a supplier with key `''`).

SQL and the import path must **call this helper**, never re-implement `lower(trim())`
inline — a second implementation would silently diverge.

## Rules Sprint 7 MUST honour (consumer contract)

1. **Store a `normalized_name` column** on `suppliers`, computed by
   `normalizeSupplierName` at write time, and apply **`unique (organization_id,
   normalized_name)`**. A SQL constraint cannot "reuse" the TS function — so the
   normalized value is written into a real column and the DB only enforces uniqueness
   on it (it does not re-derive the key in SQL).
2. **Reject the empty key** — never create a supplier from a blank/whitespace name.
3. **Deterministic display name on collision.** When `ACME`, `Acme`, `acme` all
   collapse to one key, the backfill must pick the display name by a stated, stable
   rule (e.g. most frequent, tie-broken lexicographically) so re-runs are idempotent.
4. **Idempotent backfill.** Creating one supplier per distinct normalized name per org
   from existing `ingredients.supplier` values, linking ingredients, must be
   re-runnable with no duplicates (keyed on `normalized_name`).
5. **Dual-write covers ALL writers** during the transition window: ingredient
   create/edit, imports, receiving, and supplier rename — every path that can set a
   supplier keeps the new record + the legacy column in sync.
6. **Multiple suppliers, one default.** The legacy `ingredients.supplier` text mirrors
   **only the supplier marked `is_default`**.
7. **Default rename propagates.** Renaming the default supplier updates the legacy
   `ingredients.supplier` text on **all linked ingredients** during the window.
8. **Drop legacy later.** `ingredients.supplier` is dropped only in a later sprint,
   after the dual-write window proves the linked model is the single source of truth.
