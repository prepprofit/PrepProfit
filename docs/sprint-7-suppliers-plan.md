# Sprint 7 — Suppliers (single-default v1) — implementation plan

> **Status: AUTHORIZED for LOCAL implementation** (dev review — §5 decisions
> resolved, §12 mandatory corrections folded in). **Ready to start cold in a new
> session.** Migration `0025` is **LOCAL only — PROHIBITED in production until the
> diff is reviewed**. Next module after Sprint 9 (Allergens, done). Source spec:
> `docs/expansion-plan-kitchen-ops.md` §6.2 + `docs/supplier-transition-contract.md`.

## Context

The Foundation (Sprint F, F1–F6) and Sprint 9 (Allergens) are done and on `main`.
Today a supplier is free text on `ingredients.supplier`. F6 shipped the dedup key
(`normalizeSupplierName`, `lib/suppliers/normalize.ts`) + the **transition contract**
(`docs/supplier-transition-contract.md`); F2 shipped the purchase-price math
(`approvedPriceCents`) + observe/accept services (`lib/data/ingredient-pricing.ts`) but
left the **accept-cost UI deferred to Sprint 7**. Sprint 7 turns supplier text into a
real, **manager-only** entity, links it to ingredients with a pack price that feeds
costing, and backfills the legacy data **without breaking anything that reads
`ingredients.supplier`** (dual-write window).

### Decisions locked (owner)
1. **Archive, not Trash** — `active` flag (like `employees`), no shared 30-day Trash.
2. **Pricing wired** — setting/updating the **default** link's pack price derives a
   per-unit cost and raises `pending_price_cents` (a *quote* observation); a manager
   **accepts** it via the (now shipped) F2 accept-cost UI. `price_cents` is NEVER
   mutated silently.
3. **Single-default UI, defer the gate** — schema supports multiple links; v1 UI exposes
   one default per ingredient for all plans. `procurement` Clerk feature + multi-supplier
   UI deferred to Sprint 8. **No Clerk billing changes.**

Suppliers are **manager-only** end-to-end (F4 matrix). Kitchen still *sees* the supplier
**name** on an ingredient, read-only — never contacts, packs, or prices.

---

## 1. Data model (migration `0025`, additive) — `when` > 0024's `1782066322856`

### `suppliers`
`id`, `organization_id`, `name`, `normalized_name`, `email`, `phone`, `address`,
`tax_id`, `notes`, `active boolean NOT NULL DEFAULT true`, `created_at`, `updated_at`.
- `unique (organization_id, normalized_name)` — F6 dedup key, written by
  `normalizeSupplierName` at write time (SQL never re-derives it).
- `unique (organization_id, id)` — composite-FK target.
- pg_trgm GIN on `name` (⌘K, mirrors `customers`). In `businessTables` → `org_isolation`.
  No `deleted_at`.

### `ingredient_suppliers` (the link; carries the pack)
`id`, `organization_id`, `ingredient_id`, `supplier_id`, `pack_size numeric(12,2)`,
`pack_unit text`, `pack_price_cents integer`, `is_default boolean NOT NULL DEFAULT false`,
`created_at`, `updated_at`.
- Composite FKs `(org, ingredient_id) → ingredients` **cascade**, `(org, supplier_id) →
  suppliers` **restrict**.
- `unique (org, ingredient_id, supplier_id)` (one link per pair); **partial**
  `unique (org, ingredient_id) WHERE is_default` (≤1 default/ingredient).
- `unique (org, id)` — FK target for price-history provenance (§ below).
- **DB CHECKs (§12.8):** `pack_size > 0` (when not null); `pack_price_cents >= 0`
  (when not null); **price requires size+unit** —
  `CHECK (pack_price_cents IS NULL OR (pack_size IS NOT NULL AND pack_unit IS NOT NULL))`.
- In `businessTables` → `org_isolation`.

### `ingredient_price_history` — add provenance (§12.5)
ALTER add `ingredient_supplier_id text NULL` (which quote/link produced the pending cost).
**ON DELETE SET NULL is blocked by the multi-col NOT-NULL-org limitation → use a nullable
column with an INDEX and NO FK** (provenance only; same precedent as
`inventory_movements.source_id`). `recordPriceObservation` gains an optional
`ingredientSupplierId`.

Both new types exported; both tables in `businessTables` (schema.ts) and
`buildOrgDataExport` (account-export **bump 5 → 6**).

---

## 2. Pure helpers (no I/O, tested)
- `lib/suppliers/display-name.ts` — `pickSupplierDisplayName(names: string[])`: the F6 §3
  deterministic rule (most-frequent raw spelling; tie → lexicographic). Idempotent backfill.
- Reuse `approvedPriceCents` (`lib/calculations/purchasePrice.ts`), `toCanonical` +
  a unit↔dimension check from `lib/units` (§12.7).

---

## 3. Data layer

### `lib/data/suppliers.ts`
- `listSuppliers` (active first / `includeArchived`), `getSupplierById`, `createSupplier`
  (rejects empty normalized key, F6 §2), `updateSupplier`, `archiveSupplier`,
  `reactivateSupplier`.
- **`findOrCreateSupplierByName(db, org, name)` — ATOMIC + inactive-aware (§12.4, §12.11):**
  normalize (reject `''`) → `INSERT … ON CONFLICT (org, normalized_name) DO NOTHING
  RETURNING` → if no row returned, **refetch** the existing row (never select-then-insert).
  Returns a discriminated result: `{status:'ok', supplier}` for created/active-existing;
  **`{status:'inactive', supplier}` when the existing row is archived** — the caller must
  surface `SUPPLIER_INACTIVE` (never silently attach an archived supplier; reactivation is
  an explicit manager action).
- **`archiveSupplier` (§12.10):** refuses with `SUPPLIER_IN_USE` if the supplier is
  `is_default` on any `ingredient_suppliers` link — must be replaced/removed first.
- `renameSupplier` — on renaming a supplier that is the **default** for linked ingredients,
  propagate `name` into `ingredients.supplier` on all linked rows (contract §7).

### `lib/data/ingredient-suppliers.ts`
- `listIngredientSuppliers`, `getDefaultLink`.
- **`setDefaultSupplier(db, org, ingredientId, {supplierName, packSize?, packUnit?,
  packPriceCents?})`** — the dual-write transaction, all under the caller's `withOrg` +
  `lockActiveIngredientRow`:
  1. `findOrCreateSupplierByName` → if `inactive` → return `SUPPLIER_INACTIVE`.
  2. **Validate pack unit ↔ ingredient dimension (§12.7)** → `PACK_UNIT_MISMATCH` on
     mismatch (e.g. kg on a volume ingredient).
  3. upsert the link, flip `is_default` (clear prior default).
  4. **Mirror `supplier.name` → `ingredients.supplier`** (contract §6).
  5. **Observation only when the pack actually changed (§12.6):** compare the new
     `(pack_size, pack_unit, pack_price_cents)` against the link's stored pack; if a real
     price is present **and changed**, derive cost (`approvedPriceCents`) and call
     `recordPriceObservation(source:'quote', ingredientSupplierId)` (raises
     `pending_price_cents` + a history row tagged with the link). Unchanged pack → **no
     new history, no re-opened pending**.
- `clearDefaultSupplier` / `removeIngredientSupplierLink` — unlink; if it was the default,
  clear the legacy `ingredients.supplier` text.

All org-scoped (RULE #1), inside `withOrg`.

---

## 4. Server actions (manager-only) + close the legacy paths (§12.3)
- `app/(app)/suppliers/actions.ts` — `create/update/archive/reactivateSupplierAction`;
  each `isManager()`→`FORBIDDEN` before data, Zod-validated, audited in-tx.
- Ingredient link actions (manager-only, with the ingredient editor):
  `setIngredientSupplierAction` (→ `setDefaultSupplier`), `clearIngredientSupplierAction`.
- **Remove free-text supplier from the server contract (§12.3):** delete `supplier` from
  `ingredientSchema` **and** `kitchenIngredientSchema` (`lib/validation/ingredients.ts`);
  `createIngredientAction`/`updateIngredientAction` no longer read a client `supplier`
  string. Supplier is set **only** through `setIngredientSupplierAction`. The data-layer
  `createIngredient`/`updateIngredient` keep the column (written by the link flow). UI
  hiding is not enough — the schema is the gate.
- **Accept-cost UI** reuses the existing `acceptPendingCostAction`
  (`app/(app)/ingredients/actions.ts:191`) — no new action.
- New `AuditAction`s: `supplier.create/.update/.archive/.restore`,
  `ingredient.supplierSet/.supplierClear` (metadata = ids/non-PII only; contact data never
  logged). New `ActionErrorCode`s: `SUPPLIER_IN_USE`, `SUPPLIER_INACTIVE`,
  `PACK_UNIT_MISMATCH` (the last also covers the dimension-change guard, §12.9). Reuse
  `DUPLICATE_NAME`/`NOT_FOUND`/`FORBIDDEN`/`INVALID_INPUT` otherwise.

### Dimension change guard (§12.9)
`updateIngredientAction` (manager): block changing `dimension` while any
`ingredient_suppliers` pack would become unit-incompatible → `PACK_UNIT_MISMATCH`
(remove/fix the packs first).

---

## 5. Dual-write — every server writer of `ingredients.supplier` (contract §5)
1. **Ingredient editor (manager):** supplier picker (select existing / type-to-create) +
   optional pack fields → `setIngredientSupplierAction`. Kitchen: supplier name read-only,
   no field.
2. **CSV ingredient import** (`lib/data/import.ts` apply path): a non-blank `supplier`
   cell → `findOrCreateSupplierByName` + default link + legacy mirror, **all in the same
   `withOrg` transaction as the ingredient inserts (§12.12)**. Do NOT zip two `RETURNING`
   arrays by position — build a `normalizedSupplierName → supplierId` map and create each
   ingredient then its link by explicit id. Parser (`lib/import/parse.ts`) unchanged.
3. **Backfill** (§6).
Recipe/AI import paths create ingredients without a supplier → untouched.

---

## 6. Backfill — `scripts/backfill-suppliers.ts` (idempotent; §12.1, §12.2, §12.13)
`npm run backfill:suppliers`, run once per environment. **RLS-safe: fan out over Clerk
orgs and run each org inside `withOrg`** (the cron-purge pattern in `lib/data/trash.ts` /
the purge route) — do **NOT** assume the owner connection bypasses FORCE RLS. Per org:
- group non-blank `ingredients.supplier` by `normalizeSupplierName`;
- per group, `INSERT … ON CONFLICT (org, normalized_name) DO NOTHING` a supplier with
  display `name = pickSupplierDisplayName(rawNames)`; refetch the id;
- per ingredient in the group:
  - **if it already has a default link (§12.2): keep it** — only sync
    `ingredients.supplier` to that existing default supplier's name;
  - else create a **default** link (`ON CONFLICT (org, ingredient_id, supplier_id) DO
    NOTHING`), no pack price, **and set `ingredients.supplier` = the canonical chosen
    name (§12.1)** (not the original variant).
Re-runnable with zero duplicates. Update `docs/supplier-transition-contract.md` to mark the
Sprint-7 obligations fulfilled.

---

## 7. UI (manager-only)
- **`/suppliers`** list/grid (name, contact, active badge, ingredient count), create,
  archive/reactivate; `NoAccess` for kitchen.
- **`/suppliers/[id]`** detail/editor + the ingredients it supplies.
- **Ingredient editor:** manager supplier picker + pack fields; a **pending-cost** badge +
  **Accept** button when `pending_price_cents` is set (ships the deferred F2 accept-cost
  UI via `acceptPendingCostAction`). Kitchen: read-only supplier name, no money.
- **Sidebar:** "Suppliers" in the manager-only group (reuse `canSeeFinance`).
- **⌘K:** `supplier` `SearchDescriptor` (`canAccess: canAccessFinancials`) + `searchSuppliers`
  + deep-link `/suppliers?highlight=<id>` (reuse `use-row-highlight`).
- i18n `suppliers.*` + `nav.suppliers`; all strings via next-intl.

---

## 8. Tests
- **Pure:** `lib/suppliers/display-name.test.ts`.
- **PGlite `tests/suppliers.test.ts`** (tenant_app): empty-key rejected; normalized-name
  dedup; **atomic find-or-create** returns one row; **one default per ingredient** (partial
  unique); `setDefaultSupplier` dual-writes (supplier+link+legacy mirror); rename propagates
  legacy text; **pack change raises pending; UNCHANGED pack is a no-op (no new history,
  §12.6)**; accept moves pending→price; **archive default → `SUPPLIER_IN_USE`**;
  **find-or-create of an archived name → `SUPPLIER_INACTIVE`**; **pack unit ↔ dimension
  mismatch → `PACK_UNIT_MISMATCH`**; **dimension change blocked while packs exist**; DB
  CHECKs reject `pack_size<=0`/negative price/price-without-pack; cross-org RLS isolation on
  both tables; FK restrict blocks deleting a linked supplier; price-history row carries
  `ingredient_supplier_id` (§12.5).
- **Backfill `tests/suppliers-backfill.test.ts`:** legacy text with case/whitespace variants
  → one supplier per key + default links + **legacy text synced to canonical (§12.1)**;
  **pre-existing default preserved (§12.2)**; **run twice → no duplicates**.
- **Real-PG concurrency `tests/concurrency/suppliers.pg.test.ts`** (opt-in
  `TEST_DATABASE_URL`, skipped in CI, §12.14): two simultaneous `findOrCreate` of the same
  name → exactly one row; two concurrent `setDefaultSupplier` → exactly one default remains.
- **RBAC `tests/suppliers-authz.test.ts`:** every supplier action + `setIngredientSupplierAction`
  → `FORBIDDEN` for kitchen before data; supplier search descriptor excluded for kitchen;
  the ingredient action **ignores/refuses a forged `supplier` field** (regression for §12.3).
- **`tests/account-export.test.ts`:** version **6**, both tables (real row), never another
  tenant's.
- **Import `tests/import-data.test.ts`:** a supplier cell creates supplier + default link +
  legacy mirror, **in one transaction**, mapped by name not RETURNING order (§12.12).

---

## 9. Out of scope
Multi-supplier UI + `procurement` Clerk feature (Sprint 8); purchase orders / receiving /
`cost_change` plumbing beyond F2's pending mechanism (8a/8b); dropping `ingredients.supplier`
(later, after the dual-write window); supplier hard-delete/Trash (archive only); lead
time/payment terms/min-order.

---

## 10. Definition of Done
- `npm run lint && npm run typecheck && npm test && npm run build` green.
- Migration `0025` applied **locally**; prod awaits diff review.
- Every §12 correction delivered; §8 tests green (incl. backfill idempotency + the opt-in
  real-PG concurrency suite locally).
- F4 not regressed: suppliers manager-only (pages `NoAccess`, actions `FORBIDDEN`, search
  excluded for kitchen); kitchen sees supplier name read-only, no money; **no server path
  accepts free-text supplier (§12.3)**.
- account-export bumped 5 → 6 + tested; all supplier mutations audited (no contact PII).
- `docs/supplier-transition-contract.md` updated (Sprint-7 obligations fulfilled).
- Full diff handed to the owner for review.

---

## 11. Codebase anchors
- `lib/suppliers/normalize.ts` (F6 dedup key) · `docs/supplier-transition-contract.md`.
- `lib/data/ingredient-pricing.ts` (`recordPriceObservation`/`acceptPendingCost`/
  `appendManualPriceHistory`; all take `lockActiveIngredientRow`) ·
  `lib/calculations/purchasePrice.ts` (`approvedPriceCents`).
- `lib/db/schema.ts` (`businessTables`; `customers`/`employees` patterns; partial-unique
  precedent on `inventory_movements`; composite-FK conventions).
- `lib/data/ingredients.ts` (`lockActiveIngredientRow`, `updateIngredient`) ·
  `app/(app)/ingredients/actions.ts` (`acceptPendingCostAction:191`; supplier removal).
- `lib/validation/ingredients.ts` (remove `supplier`) · `lib/data/import.ts` (apply path).
- `lib/search/registry.ts` + `queries.ts` (manager-only descriptor) · `use-row-highlight`.
- `lib/data/trash.ts` / cron purge route (Clerk-org fan-out for the backfill).
- `lib/data/account-export.ts:44` (`ACCOUNT_EXPORT_SCHEMA_VERSION` 5 → 6) ·
  `lib/data/audit.ts` (new actions) · `lib/action-result.ts` (new codes).
- `drizzle/meta/_journal.json` (max `when` 1782066322856 = 0024; 0025 must exceed it).

---

## 12. Mandatory corrections (dev review — all REQUIRED)
1. **Backfill syncs the legacy mirror:** after grouping, set `ingredients.supplier` to the
   chosen canonical name (do NOT leave the original variant) — the dual-write contract.
2. **Respect existing defaults:** if an ingredient already has a default link, the backfill
   must NOT create another — the existing default wins; only sync the legacy field.
3. **Close the old free-text paths server-side:** remove `supplier` from the ingredient Zod
   schemas + actions (kitchen and generic). Hiding it in the UI is not enough.
4. **Atomic find-or-create:** `findOrCreateSupplierByName` = INSERT … ON CONFLICT DO NOTHING
   + refetch, never select-then-insert.
5. **Price provenance:** `ingredient_price_history` stores `ingredient_supplier_id` (which
   quote created the pending cost).
6. **No duplicate observations:** saving the same supplier + same pack must NOT add a history
   row nor re-open pending.
7. **Compatible units:** validate the pack unit belongs to the ingredient's dimension (no kg
   on a volume ingredient).
8. **DB checks:** `pack_size > 0`, price `>= 0`, and price only when size+unit are present.
9. **Dimension change:** block changing an ingredient's dimension while incompatible packs
   exist.
10. **Archiving a default:** block with `SUPPLIER_IN_USE` until replaced or removed.
11. **Inactive supplier:** find-or-create must not silently attach an archived supplier —
    return `SUPPLIER_INACTIVE` or require explicit reactivation.
12. **Import transactional:** create ingredients + suppliers + links in ONE transaction; do
    not assume `RETURNING` order matches file order — map by name/id.
13. **Backfill + RLS:** do not assume the owner bypasses FORCE RLS — run per-organization
    (Clerk-org fan-out + `withOrg`) or a verified-`BYPASSRLS` admin connection.
14. **Real concurrency:** add real-PostgreSQL tests for simultaneous same-supplier creation
    and two concurrent default changes (opt-in, skipped in CI).

### Approved as-is
Separate `suppliers` + `ingredient_suppliers` tables · one default per ingredient · archive
not delete · kitchen sees name only (no contacts/packs/prices) · search + admin manager-only
· GDPR export 5 → 6 · migration 0025 local-only until diff review · no billing change.
