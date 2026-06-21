# Sprint F2 — Canonical unit & purchase-price model — implementation plan

> **Status:** UNAUTHORIZED until the dev signs off (F1 is merged + prod-migrated;
> F2 is the next Foundation slice). Source spec: `docs/expansion-plan-kitchen-ops.md`
> §4 F2 (fixes review #1). Build in one slice, full review at the end, **local
> migration only** until the diff is reviewed (same delivery contract as F1).
> **Captured:** 2026-06-21, against `main` at the F1 merge.

---

## 1. Goal (what F2 actually is)

F2 is mostly a **pure calculation module** plus the **"approved cost" data
plumbing**. It does **not** build suppliers — `suppliers` / `ingredient_suppliers`
are **Sprint 7**. F2 ships the primitives Sprint 7/8 will write into:

1. A pure function that converts a **purchase pack price** into the **approved cost
   per priced unit** that `recipeCost.ts` already consumes.
2. An **`ingredient_price_history`** log of observed/derived costs.
3. A **cost-change pending** signal on ingredients ("a newer cost was seen, manager
   must accept it").
4. An **audited, manager-only "accept new cost"** action that is the *only* path
   allowed to move `ingredients.price_cents`, plus a **record-observation service**
   (no silent price mutation).

**Invariant locked by F2:** `ingredients.price_cents` = the **approved cost per
PRICED unit** (per kg / per litre / per piece), in integer cents — exactly what
`lib/calculations/recipeCost.ts` (`lineCostCents`) consumes via
`CANONICAL_PER_PRICE_UNIT` (1000 weight/volume, 1 count). Nothing receiving or
quoting may change it silently.

---

## 2. The pure conversion (the core deliverable)

Create **`lib/calculations/purchasePrice.ts`** — one pure function, no I/O:

```
PRICE_UNIT_SIZE    = CANONICAL_PER_PRICE_UNIT[dimension]   // 1000 weight/volume, 1 count
canonicalPack      = toCanonical(packSize, packUnit)        // grams / ml / count
approvedPriceCents = round( packPriceCents × PRICE_UNIT_SIZE ÷ canonicalPack )
```

**Worked examples (must be asserted in tests — they prove the v2 c/gram bug is gone):**

| Pack          | Calc                  | Result         |
|---------------|-----------------------|----------------|
| 1 kg @ €5     | 500 × 1000 ÷ 1000     | **500 c/kg**   |
| 5 kg @ €20    | 2000 × 1000 ÷ 5000    | **400 c/kg**   |
| 500 ml @ €2   | 200 × 1000 ÷ 500      | **400 c/l**    |
| 12 pcs @ €3   | 300 × 1 ÷ 12          | **25 c/piece** |

**Signature suggestion:**

```ts
export function approvedPriceCents(input: {
  packPriceCents: number;   // integer cents for the whole pack
  packSize: number;         // e.g. 5
  packUnit: Unit;           // 'kg' | 'l' | 'count' | ...
  dimension: Dimension;     // determines PRICE_UNIT_SIZE
}): number
```

**Edge handling (tests required):** `canonicalPack === 0` (or pack size ≤ 0) →
guard (return `0` or throw — see decision §7); negative inputs rejected upstream by
Zod; `Math.round` half-up boundary cases; each of the 3 dimensions.

**Single source of truth:** today `CANONICAL_PER_PRICE_UNIT` is **private** in
`lib/calculations/recipeCost.ts`. Extract it (export from `recipeCost.ts`, or a tiny
`lib/calculations/units-money.ts`) and have **both** `recipeCost.ts` and
`purchasePrice.ts` import it — otherwise the constant drifts. Unit conversion reuses
`toCanonical` from `lib/units/index.ts`.

---

## 3. Schema changes — migration `0021`

### 3a. New table `ingredient_price_history` (`lib/db/schema.ts`)

Append-the-observations log. Each row = one observed pack price → derived approved
cost, with provenance.

Columns: `id`, `organization_id`, `ingredient_id` (text), `source text`
(`'manual' | 'order' | 'quote' | 'import'`), `pack_size numeric`, `pack_unit text`,
`pack_price_cents integer`, `derived_price_cents integer` (the `approvedPriceCents`
result), `accepted boolean default false` (true when this observation became
`ingredients.price_cents`), `actor_user_id text` (nullable), `note text`,
`created_at`.

Constraints (mirror existing patterns):

- `index (organization_id)`, `index (organization_id, ingredient_id, created_at)`
  (history view, newest-first).
- Composite FK `(organization_id, ingredient_id) → ingredients(organization_id, id)`
  **`onDelete cascade`** (history dies with the ingredient — matches §F3 "retained
  until full ingredient purge").
- Add `'ingredient_price_history'` to **`businessTables`** so RLS is applied.
  **Decision §7:** standard `org_isolation` (recommended) vs append-only.

### 3b. Cost-change pending signal on `ingredients` (`lib/db/schema.ts`)

Add **`pending_price_cents integer` (nullable)** = the latest observed approved cost
awaiting manager acceptance (NULL = nothing pending). The UI shows "cost changed:
€X.XX → accept?" when it's non-null and ≠ `price_cents`. (Reuses the existing
`needs_pricing` boolean for the *unpriced* case; `pending_price_cents` is the
distinct *changed* case.)

### 3c. Migration mechanics

- `npm run db:generate` → `0021`, then **verify `_journal.json` `when` > 1782023545688**
  (current max = F1's 0020); `migrate-guard` also aborts if not.
- Purely additive (new table + nullable column) → **no backfill/staging needed**
  (unlike F1). Existing ingredients get `pending_price_cents = NULL`.
- RLS auto-applies from `rlsStatements` on `npm run db:migrate`.
- **Apply LOCALLY/dev only; prod waits for the diff review** (F1 contract).

---

## 4. Data layer & actions

### `lib/data/ingredient-pricing.ts` (new)

- `recordPriceObservation(tx, org, { ingredientId, source, packSize, packUnit,
  packPriceCents, dimension, actorUserId, note? })` — computes `approvedPriceCents`,
  inserts an `ingredient_price_history` row (`accepted=false`), and sets
  `ingredients.pending_price_cents` to the derived value. **Never touches
  `price_cents`.** This is the API Sprint 7 (quotes) and 8b (receiving) call.
- `acceptPendingCost(tx, org, ingredientId)` — sets `price_cents = pending_price_cents`,
  clears `pending_price_cents`, clears `needs_pricing` if the accepted value > 0,
  marks the latest history row `accepted=true`. Returns the updated ingredient (or
  null/not-found).

### `app/(app)/ingredients/actions.ts`

- **`acceptPendingCostAction(id)`** — canonical order: **`isManager()` → FORBIDDEN**
  (price is financial; pre-empts F4) → `withOrg` → `acceptPendingCost` +
  `writeAuditEvent` in the **same tx** → `revalidateIngredientConsumers()` (already
  refreshes `/ingredients` + `/recipes`).
- **Audit:** the existing `updateIngredientAction` is **not** audited today. F2
  should audit price moves. Add audit action keys to `lib/data/audit.ts`
  (`AuditAction`): **`ingredient.priceAccept`** (and **`ingredient.priceUpdate`** if
  we also audit manual edits — see §7). Metadata = **ids + old/new cents only**
  (money tied to an ingredient, not a person → allowed; no PII).

---

## 5. Files to CHANGE (impact map)

- `lib/db/schema.ts` — new `ingredientPriceHistory` table + `pendingPriceCents`
  column on `ingredients`; add table to `businessTables`; export types
  (`IngredientPriceHistory`, `NewIngredientPriceHistory`).
- `lib/calculations/recipeCost.ts` — export `CANONICAL_PER_PRICE_UNIT` (or move to a
  shared module).
- `lib/data/audit.ts` — add `ingredient.priceAccept` (+ optional
  `ingredient.priceUpdate`) to `AuditAction`.
- `app/(app)/ingredients/actions.ts` — new `acceptPendingCostAction`; optionally
  audit `updateIngredientAction` price changes.
- `lib/data/account-export.ts` — add `['ingredientPriceHistory',
  ingredientPriceHistory]` to the table list **and bump
  `ACCOUNT_EXPORT_SCHEMA_VERSION` 1 → 2** (DoD: new table in export ⇒ version bump).
  Update the `schemaVersion` assertion in `tests/account-export.test.ts`.
- `lib/i18n/messages/en.json` — UI strings for the accept-cost surface + any new
  `ActionErrorCode` (only if needed; reuse `FORBIDDEN`/`NOT_FOUND`/`INVALID_INPUT`).
- `scripts/seed-demo.ts` — optional: seed a couple of history rows / one
  `pending_price_cents` so the UI has data.
- **Purge/GDPR:** confirm the 30-day purge path and account-deletion path cover the
  new table (cascade via the ingredient FK handles ingredient purge; verify the
  deletion bundle/cron need no explicit entry).

---

## 6. Files to CREATE

- `lib/calculations/purchasePrice.ts` + `lib/calculations/purchasePrice.test.ts`
  (the 4 worked examples, 3 dimensions, `canonicalPack=0` guard, rounding
  boundaries — per CLAUDE.md money-test rules: zero/negative/large/rounding/NaN/
  Infinity).
- `lib/data/ingredient-pricing.ts` + `tests/ingredient-pricing.test.ts` (PGlite,
  under `tenant_app` role): `recordPriceObservation` writes history + sets
  `pending_price_cents` but **leaves `price_cents` untouched**; `acceptPendingCost`
  moves the price + clears flags + marks history accepted; org-isolation (no
  cross-tenant read/write); cascade purge removes history.
- Extend `tests/rbac-actions-authz.test.ts` — `acceptPendingCostAction` returns
  **`FORBIDDEN` before any data access** for a kitchen user, and audits on success
  for a manager.

---

## 7. Decisions — RESOLVED by the product owner (2026-06-21)

1. **`ingredient_price_history` RLS:** ✅ **APPROVED `org_isolation`** (standard
   read/write; it's a log, not a compliance trail — accept needs to flip `accepted`).
2. **`canonicalPack = 0` behavior:** ✅ **APPROVED throwing a typed error**
   (`InvalidPackSizeError`); a zero/negative/NaN pack is a data bug, never a silent 0.
3. **Audit scope:** ✅ **APPROVED auditing BOTH** the accept action
   (`ingredient.priceAccept`) AND a manual `price_cents` edit (`ingredient.priceUpdate`).
4. **Pending model:** ✅ **APPROVED the nullable `pending_price_cents` column.**
5. **Manual entry path:** ✅ **APPROVED writing a `source='manual'` history row**
   (auto-`accepted`) on a manual price set.

### Two owner adjustments to fold in (2026-06-21)

A. **`updateIngredientAction` currently changes `price_cents` with NO RBAC.** That
   path must become manager-gated. **Implementation:** the action loads the current
   row (under the lock — see B), and if the submitted `priceCents` differs from the
   stored one it requires `isManager()` → **`FORBIDDEN` before the write**; non-price
   edits (name/supplier) stay open to kitchen. Changing the price also writes the
   manual history row + `ingredient.priceUpdate` audit (decisions 3 & 5). Hiding the
   price *field* from kitchen in the UI is finished in **F4**; F2 enforces it server-side.
   (Create-with-price RBAC is likewise completed in F4; F2 only writes the history row
   on create.)

B. **Observation and acceptance must lock/serialize the ingredient.** Both
   `recordPriceObservation` and `acceptPendingCost` (and the manual-edit price path)
   take a **`SELECT … FOR UPDATE`** on the ingredient row first (reuse the F1
   `lockActive…` pattern), so a concurrent observe + accept can't race and accept the
   wrong "latest" history line. A real-PG concurrency test is optional but the FOR
   UPDATE serialization is mandatory.

---

## 8. Definition of Done (per spec §3 + F1 precedent)

- `npm run lint && npm run typecheck && npm test && npm run build` **green**.
- Money edge tests (zero/negative/large/rounding/NaN/Infinity) on `purchasePrice.ts`.
- RLS 4-way tests on `ingredient_price_history` (SELECT isolation, INSERT WITH CHECK,
  cross-org write blocked, cascade purge).
- RBAC test: `acceptPendingCostAction` → `FORBIDDEN` before data for kitchen.
- GDPR: new table in account-export bundle + **schemaVersion bumped**; purge/seed
  updated.
- Migration `0021` applied **locally/dev only**; `when` > 1782023545688 verified.
- **Full diff handed to the dev before F3 is authorized.** F3–F6 stay unauthorized.

---

## 9. Out of scope for F2 (do NOT build)

- `suppliers` / `ingredient_suppliers` tables, pack columns, multi-supplier UI,
  `is_default` link → **Sprint 7**.
- Receiving / quotes that *call* `recordPriceObservation` → **Sprint 7/8**.
- The F4 kitchen money-visibility retrofit (F2 only pre-empts price-edit RBAC on its
  own new action).

---

## 10. Codebase anchors (for a cold start)

- `lib/calculations/recipeCost.ts` — `CANONICAL_PER_PRICE_UNIT` (1000/1000/1),
  `lineCostCents`. Costs are computed LIVE from `ingredients.price_cents`.
- `lib/units/index.ts` — `Dimension`, `Unit`, `toCanonical(value, unit)`.
- `lib/db/schema.ts` — `ingredients` (`price_cents`, `needs_pricing`, `dimension`),
  `businessTables`, composite-FK + `(org,id)` unique patterns.
- `lib/db/rls.ts` — `APPEND_ONLY_TABLES` set vs `org_isolation`.
- `lib/data/audit.ts` — `AuditAction`, `auditActor()`, `writeAuditEvent()`
  (in-tx, metadata = non-PII descriptors only).
- `app/(app)/ingredients/actions.ts` — existing create/update/delete actions +
  `revalidateIngredientConsumers()` (refreshes `/ingredients` + `/recipes`).
- `lib/data/account-export.ts` — GDPR bundle table list + `ACCOUNT_EXPORT_SCHEMA_VERSION`.
- Test patterns: `tests/helpers/db.ts` (PGlite + RLS + `tenant_app`),
  `tests/audit-log.test.ts` (append-only RLS), `tests/inventory-idempotency.test.ts`
  (F1, action-level mocking of `@/lib/auth` + `@/lib/db`).
