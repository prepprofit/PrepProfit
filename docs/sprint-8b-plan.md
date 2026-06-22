# Sprint 8b — Purchase Orders (receiving) — implementation plan

> **Status: IMPLEMENTED locally — full gate green (lint + typecheck + 801 tests + build),
> awaiting diff review before the prod migration** (F/7/8a cadence; owner may override and
> authorize prod directly, as in F5/F6/8a). v2 of this plan (D1–D6 LOCKED + 7 blockers
> resolved) was the build spec; everything below shipped as written. Migration `0027` was
> applied **LOCALLY only** (via the PGlite test harness — `npm run db:migrate` against prod
> Neon is **NOT** run yet). Source spec: `docs/expansion-plan-kitchen-ops.md` §6.3 (8b) +
> `docs/document-snapshot-policy.md` + Foundation **F1** (idempotent ledger) and **F2**
> (canonical price model). Builds directly on Sprint 8a (`docs/sprint-8a-plan.md`).
>
> **What shipped:** schema + migration `0027` (status enum extension, `purchase_order_items.
> quantity` 12,3→12,2 [B1], `receipts` + `receipt_items` with the binding FKs [B5],
> `ingredient_price_history.source_receipt_item_id` [B3]); `lib/data/receipts.ts`
> (`postReceipt`/`voidReceipt`/`closePurchaseOrder`/`receivedRollup`); F2 helpers
> `recordDerivedPriceObservation` + `recomputePendingAfterVoid`; `cancelPurchaseOrder`
> D5 guard; `lib/validation/receipts.ts` (+ `receiptPayloadHash`); `receipt-actions.ts`;
> the `ReceivePanel` UI on the PO detail page; audit actions + error codes + i18n;
> account-export 7→8; the trash purge-block extension; `tests/receipts.test.ts` (11 cases)
> + opt-in `tests/concurrency/receipts.pg.test.ts`. Docs updated:
> `docs/document-snapshot-policy.md` (Sprint 8b Policy-B note).

## Decisions LOCKED (was D1–D6 — confirmed by the dev)

1. **D1 — Over-delivery allowed.** A cumulative received quantity may exceed the ordered
   quantity. The UI shows an **"over" badge** and requires an **explicit confirmation**
   before posting. `received` is **terminal**: further deliveries against a `received` PO
   require a reopen (out of v1; reopen happens only as a side effect of a void, §3).
2. **D2 — Received rollup is computed, not stored.** Per-line received =
   `Σ receipt_items.received_quantity` over **`posted`** receipts only (voided receipts
   excluded). Add index `receipt_items (organization_id, purchase_order_item_id)` so the
   rollup and the purge-block check are cheap. No denormalized column.
3. **D3 — `recordDerivedPriceObservation` with pack columns NULL.** The received cost is
   recorded as an already-per-priced-unit observation; **the old supplier-link pack is NOT
   copied** (it might not reconcile with the received cost). Provenance is the
   `receipt_item.id` (new `source_receipt_item_id` column on `ingredient_price_history`).
4. **D4 — Explicit short-close, reason mandatory.** Closing a `partially_received` PO
   ("no more coming") is its own action and requires a reason
   (`PO_CLOSE_REASON_REQUIRED`); it flips status to `received` and stores `closed_reason`.
5. **D5 — Cancel blocked while any `posted` receipt exists.** Returns
   `PO_NOT_CANCELLABLE`. After **all** receipts are voided the PO recomputes back to
   `sent` and becomes cancellable again.
6. **D6 — Persistent form-level idempotency.** `receipts.client_mutation_id` (NOT NULL) +
   `unique (organization_id, client_mutation_id)` + a **payload fingerprint**
   (`payload_hash`). Same id **+ same** fingerprint → return the **existing** receipt
   (no-op); same id **+ different** fingerprint → `IDEMPOTENCY_CONFLICT`. This check runs
   **before** any status validation (Blocker B2).

## Blockers RESOLVED (dev review)

- **B1 — Precision alignment (hard blocker).** The stock domain is uniformly
  `numeric(12,2)` (`ingredients.stock_quantity`/`low_stock_threshold`,
  `inventory_movements.delta_canonical`, `recipe_ingredients.quantity`), but 8a's
  `purchase_order_items.quantity` is `numeric(12,3)` — a receipt of `1.235` canonical
  would not reconcile with the ledger. **Resolution: standardize the whole stock domain on
  `numeric(12,2)`** — the authoritative F1 ledger is **never** migrated. Migration `0027`
  **alters `purchase_order_items.quantity` from `(12,3)` → `(12,2)`** (rounds; safe — 8a
  values are canonical grams/ml/count, integer in practice), and
  `receipt_items.received_quantity` is `numeric(12,2)`. *Prod caveat:* confirm 8a's `0026`
  state in prod before applying; the down-scale is loss-free only if no existing PO line
  used a sub-centigram value (none expected).
- **B2 — D6 dedup must precede status validation.** `postReceipt` step **0** is the
  `client_mutation_id` lookup; a retry that arrives after the first request already flipped
  the PO to `received` returns the **already-created receipt**, not `PO_NOT_RECEIVABLE`.
- **B3 — Void × F2 pending cost is now defined.** Price observations carry
  `source_receipt_item_id`. Voiding a receipt: history rows are **kept** (append-only log);
  `pending_price_cents` is **recomputed** — if the current pending value came from a
  voided receipt's observation and was **not yet accepted**, it falls back to the latest
  remaining unaccepted observation for that ingredient (or `NULL`). **An already-accepted
  cost is NEVER silently reverted** (`price_cents` is untouched).
- **B4 — Reversal can hit the stock floor.** If the received goods were already consumed,
  the void's negative movement would drive stock below zero. F1 rejects it
  (`MovementError('insufficient_stock')`); the void **fails with `INSUFFICIENT_STOCK` and
  is blocked** — the manager must resolve stock first (explicit, documented behavior; no
  silent partial void).
- **B5 — FKs must not allow cross-PO / cross-receipt mixing.** `receipt_items` carries
  `purchase_order_id` + `receipt_id` + `purchase_order_item_id`, all **NOT NULL**, with
  composite FKs that bind them together (§1). A receipt line therefore cannot reference a
  line from a different PO, nor a receipt from a different PO. The line's ingredient is
  copied from the resolved PO line and re-validated in the app layer.
- **B6 — Short-close × void reopen rule.** Voiding any receipt of a `received` PO
  recomputes its status downward; if the PO was **short-closed**, the void **clears
  `closed_reason` + `received_at`** and reopens it to `partially_received`/`sent`. (No
  separate reopen action in v1 — reopen is a side effect of void only.)

---

## Context

Sprint 8a shipped the purchase-order **document**: draft → send (freeze supplier + line
snapshot, queue the email) → historical record, with a `sent` PO as a dead end. **8b
closes the loop: receiving.** A manager books deliveries against a `sent` PO — supporting
**multiple partial deliveries** — and each delivery:

1. writes **idempotent IN stock movements** through the F1 ledger
   (`source_type='purchase_receipt'`), so retries never double-count;
2. records the **observed purchase price** against price history and raises the F2
   **pending cost** for a manager to accept — it **never** mutates `price_cents` silently;
3. rolls the PO forward `sent → partially_received → received`.

Corrections never edit a movement (the ledger is append-only): a correction **voids** a
receipt and posts F1 **reversals**.

---

## 1. Data model — migration `0027` (additive + one ALTER), `when` > current journal max

Bump the new migration's journal `when` above the current max in
`drizzle/meta/_journal.json` (the migrate-guard aborts otherwise). New tables go in
`businessTables` → `org_isolation` RLS, and into `buildOrgDataExport` (account-export
**bump 7 → 8**).

### `purchase_orders` — status extension + new FK target (ALTER)
- Status enum + CHECK: `('draft','sent','cancelled')` →
  `('draft','sent','partially_received','received','cancelled')`. The migration **drops
  and re-adds** `purchase_orders_status_chk` (additive; existing rows stay valid).
- Add `received_at timestamptz NULL` (first time it reaches `received`) and
  `closed_reason text NULL` (set only on a short-close, D4).
- No new FK target needed here (the PO already has `unique (org, id)` from 8a; the
  PO↔line binding target is added on `purchase_order_items` below).

### `purchase_order_items` — precision fix + FK target (ALTER)
- **`quantity`: `numeric(12,3)` → `numeric(12,2)`** (Blocker B1).
- Add **`unique (organization_id, purchase_order_id, id)`** — the composite FK target so a
  `receipt_item` can prove its ordered line belongs to the stated PO (Blocker B5).

### `receipts` (one delivery event; many per PO = partial deliveries)
`id`, `organization_id`, `purchase_order_id text NOT NULL`,
`received_date date NOT NULL` (bare 'YYYY-MM-DD'), `notes text NULL`,
`status text NOT NULL DEFAULT 'posted'` (`posted | voided`), `voided_at timestamptz NULL`,
`actor_user_id text NULL`, **`client_mutation_id text NOT NULL`** (D6),
**`payload_hash text NOT NULL`** (D6 fingerprint), `created_at`, `updated_at`.
- `unique (organization_id, id)` (FK target).
- **`unique (organization_id, id, purchase_order_id)`** (composite FK target for
  `receipt_items`, binds an item to its receipt's PO — B5).
- **`unique (organization_id, client_mutation_id)`** (D6 form-level idempotency).
- Composite FK `(org, purchase_order_id) → purchase_orders` **`ON DELETE restrict`** (a PO
  with receipts is historical; only drafts hard-delete, and a draft has no receipts).
- CHECK `status IN ('posted','voided')`.
- Indexes: `(org)`, `(org, purchase_order_id)`.

### `receipt_items`
`id`, `organization_id`, `receipt_id text NOT NULL`,
`purchase_order_id text NOT NULL` (denormalized for the binding FK),
`purchase_order_item_id text NOT NULL` (live link to the ordered line),
`ingredient_id text NOT NULL` (live link), `ingredient_name text NOT NULL` +
`dimension text NOT NULL` (**snapshot frozen at receipt time**),
`received_quantity numeric(12,2) NOT NULL` (**canonical** g/ml/count),
`received_unit_cost_cents integer NOT NULL` (per priced unit — kg/l/piece),
`line_total_cents integer NOT NULL DEFAULT 0` (frozen at receipt),
`sort_order integer NOT NULL DEFAULT 0`.
- Composite FK `(org, receipt_id) → receipts(org, id)` **cascade**.
- Composite FK **`(org, receipt_id, purchase_order_id) → receipts(org, id,
  purchase_order_id)`** **restrict** — binds the line's PO to its receipt's PO (B5).
- Composite FK **`(org, purchase_order_id, purchase_order_item_id) → purchase_order_items(
  org, purchase_order_id, id)`** **restrict** — the ordered line must belong to that PO (B5).
- Composite FK `(org, ingredient_id) → ingredients(org, id)` **restrict** (purge-block, §7).
- CHECKs: `received_quantity > 0`, `received_unit_cost_cents >= 0`.
- Indexes: `(org, receipt_id)`, **`(org, purchase_order_item_id)`** (D2 rollup +
  purge-block), `(org, ingredient_id)`.

### `ingredient_price_history` — provenance (ALTER)
- Add **`source_receipt_item_id text NULL`** (no FK — provenance only, same precedent as
  `ingredient_supplier_id`/`inventory_movements.source_id`), indexed
  `(org, source_receipt_item_id)`. Lets a void find "the pending value that came from this
  receipt" (B3).

### No `email_outbox` change
Receiving does not email in v1 (`document_type` stays `('purchase_order')`).

---

## 2. Pure helpers + F2 wiring (tested)
- **Reuse** `lib/calculations/purchaseOrder.ts` (`purchaseOrderLineTotal` / totals) for
  receipt-line and received-total math (canonical convention is identical). Add
  `receivedTotals(lines)` if helpful; tested for money edges (zero, int4 cap, rounding,
  count vs weight/volume).
- **`lib/data/ingredient-pricing.ts` — add `recordDerivedPriceObservation` (D3):** takes an
  already-derived per-priced-unit `derivedPriceCents` + `sourceReceiptItemId`, inserts a
  `source='order'` `ingredient_price_history` row with **pack columns NULL**, sets
  `pending_price_cents`, never touches `price_cents`. Locks the ingredient `FOR UPDATE`
  first (same pattern as `recordPriceObservation`).
- **`recomputePendingAfterVoid(db, org, ingredientId, voidedReceiptItemIds)` (B3):** if the
  ingredient's current `pending_price_cents` traces to one of the voided items' history rows
  and is **not accepted**, recompute pending to the latest remaining unaccepted observation
  (or `NULL`); if accepted, leave `price_cents` untouched. Pure-ish (DB read+write), tested.
- **Snapshot:** reuse 8a `ingredientLineSnapshot()` for `{ ingredientName, dimension }`,
  keeping the receipt's **own** `received_unit_cost_cents` (the 8a "freeze keeps line cost,
  not approved cost" trap applies; a test asserts it).
- **Payload fingerprint:** pure `receiptPayloadHash(input)` (stable JSON of the
  normalized lines + date) for D6.

---

## 3. State machine + data layer

### PO status transitions
| From → To | Trigger | Effect | Blocked / error |
| --- | --- | --- | --- |
| `sent`/`partially_received` → `partially_received` | postReceipt (lines still short) | dedup → insert receipt+items → F1 IN movements → F2 observe → recompute rollup | not receivable → `PO_NOT_RECEIVABLE`; empty → `RECEIPT_EMPTY`; trashed line → `PO_LINE_INGREDIENT_MISSING`; dup id/diff payload → `IDEMPOTENCY_CONFLICT` |
| `sent`/`partially_received` → `received` | postReceipt completing all lines | as above + stamp `received_at` | — |
| `partially_received` → `received` | closePurchaseOrder (D4) | stamp `received_at` + `closed_reason` | no reason → `PO_CLOSE_REASON_REQUIRED`; not partial → `PO_NOT_RECEIVABLE` |
| `posted` receipt → `voided` | voidReceipt | F1 **reversals** for every item movement; B3 pending recompute; recompute PO status; clear closure if short-closed (B6) | already voided → idempotent ok; goods consumed → `INSUFFICIENT_STOCK` (B4) |
| `sent` → `cancelled` | cancel (8a) | unchanged | — |
| any state with a `posted` receipt → `cancelled` | cancel | **blocked** | `PO_NOT_CANCELLABLE` (D5) |

`received` is terminal for new receipts (D1); the only way back is a void.

### `lib/data/receipts.ts` (new)
- `listReceiptsForPurchaseOrder` + `getReceiptWithItems`; `receivedRollup(db, org, poId)`
  = per-`purchase_order_item_id` `SUM(received_quantity)` over `status='posted'` (D2).
- **`postReceipt(db, org, actor, input)`:**
  0. **D6 dedup (before anything else, B2):** look up `client_mutation_id`. Found + same
     `payload_hash` → return the existing receipt (`{ ok:true, deduped:true }`); found +
     different → `IDEMPOTENCY_CONFLICT`.
  1. `SELECT … FOR UPDATE` the PO; assert `status IN ('sent','partially_received')` →
     else `PO_NOT_RECEIVABLE`.
  2. Non-empty lines (`RECEIPT_EMPTY`); resolve each to its PO line (binding FK guarantees
     same PO) + live active ingredient (NULL/trashed → `PO_LINE_INGREDIENT_MISSING`).
  3. Insert the `receipts` row (with `client_mutation_id` + `payload_hash`) + `receipt_items`
     (freeze name/dimension, compute `line_total_cents`).
  4. **F1 IN movements** via `recordMovements` (locks ingredients id-asc, throws to roll
     back the whole `withOrg`): one per item, `+received_quantity`,
     `source_type='purchase_receipt'`, key
     `buildMovementKey('purchase_receipt', receiptId, receiptItemId, ingredientId)`.
  5. **F2 observe** per item: `recordDerivedPriceObservation(...
     received_unit_cost_cents, sourceReceiptItemId)`.
  6. Recompute rollup → set PO status (`partially_received`/`received`, stamp `received_at`).
- **`voidReceipt(db, org, receiptId)`:** `FOR UPDATE` the receipt; `voided` already →
  idempotent ok. For each item's IN movement, post an F1 reversal (opposite delta,
  `source_type='reversal'`, `reversalOf=<id>`) via the batch path — if stock would go
  negative it **throws `insufficient_stock` → `INSUFFICIENT_STOCK`, void blocked** (B4); the
  partial-unique `(org, reversal_of)` guarantees one reversal per movement. Flip receipt to
  `voided`; **B3** pending recompute; recompute PO status; **B6** if the PO was short-closed,
  clear `closed_reason` + `received_at`. Manager-only + audited.
- **`closePurchaseOrder(db, org, poId, reason)` (D4):** assert `partially_received`,
  require `reason`, stamp `received_at` + `closed_reason`, flip to `received`. No stock effect.
- **Cancel (extend 8a `cancelPurchaseOrder`):** refuse when a `posted` receipt exists
  (`PO_NOT_CANCELLABLE`, D5).

---

## 4. Server actions, validation, audit
- `app/(app)/purchase-orders/receipt-actions.ts` — `postReceiptAction`, `voidReceiptAction`,
  `closePurchaseOrderAction`; each `isManager()` → `FORBIDDEN` **before** data, Zod-validated,
  audited. The client supplies a persistent `clientMutationId` (uuid, generated once per
  receive form, rotated only after a successful post — the F1 `mutationId` precedent).
- **Validation `lib/validation/receipts.ts`** — int4/length caps (mirror
  `lib/validation/purchase-orders.ts`): cap `received_quantity`, `received_unit_cost_cents`,
  line count, computed totals (`superRefine`); bound `notes`/`closed_reason`;
  `received_date` a real calendar date; `clientMutationId` a uuid.
- **New `AuditAction`s** (`lib/data/audit.ts`): `purchaseOrder.receive`,
  `purchaseOrder.receiptVoid`, `purchaseOrder.close`. Metadata = ids + counts + status only
  (line/movement counts, new PO status); **never** supplier PII or per-person money.
- **New `ActionErrorCode`s** (`lib/action-result.ts`): `PO_NOT_RECEIVABLE`, `RECEIPT_EMPTY`,
  `PO_CLOSE_REASON_REQUIRED`, `PO_NOT_CANCELLABLE` (reuse `IDEMPOTENCY_CONFLICT`,
  `INSUFFICIENT_STOCK`, `PO_LINE_INGREDIENT_MISSING`, `NOT_FOUND`, `FORBIDDEN`,
  `INVALID_INPUT`). Add matching `actionErrors.*` i18n keys (`en.json`, single locale).
- **UI:** on `/purchase-orders/[id]` for a `sent`/`partially_received` PO, a **Receive**
  panel — per ordered line: ordered qty, already-received (D2), this-delivery qty +
  received unit cost (defaulted from the line), received-date, notes; **Post receipt** (with
  over-delivery confirmation, D1), **Short-close** (reason), and a **receipts history** list
  with **Void** per posted receipt. Surface the F2 "pending cost — accept?" hint linking to
  `/ingredients`. i18n `purchaseOrders.receive.*` / `receipts.*`.

---

## 5. RBAC / entitlements / money visibility (F4)
Receiving is procurement/financial → **manager-only end-to-end** (page `NoAccess`, every
action `FORBIDDEN` before data, no money leaks to kitchen). No feature gate (mirrors 8a).

## 6. Search
No new ⌘K descriptor — receipts are reached through their PO (8a `purchaseOrder` descriptor).

## 7. Purge / snapshot integrity — F3 Policy B (extend)
8a purge-blocks an ingredient referenced by a non-draft PO in `purgeExpired`
(`lib/data/trash.ts`). 8b adds a symmetric `NOT EXISTS` arm for **`receipt_items`**: an
ingredient on any receipt line is **kept in trash, never purged** (the receipt + its IN
movement are permanent inventory history). Update `docs/document-snapshot-policy.md` to
record the receipt reference-check in the Policy-B set.

## 8. Tests
- **Pure:** `purchaseOrder.test.ts` (received-total math, int4/rounding edges);
  `ingredient-pricing.test.ts` (`recordDerivedPriceObservation` sets pending, pack NULL,
  never `price_cents`; `recomputePendingAfterVoid` cases incl. already-accepted untouched);
  `receiptPayloadHash` stability.
- **PGlite `tests/receipts.test.ts`:** partial receipt → `partially_received`, stock IN once,
  F2 pending raised w/ `source_receipt_item_id`; remainder → `received` + `received_at`;
  **D6: same `clientMutationId`+payload → one receipt (returns existing); different payload →
  `IDEMPOTENCY_CONFLICT`; retry after PO already `received` returns the existing receipt
  (B2)**; over-delivery allowed (D1); void → reversals net stock back, pending recomputed,
  PO drops down; **void after consumption → `INSUFFICIENT_STOCK`, blocked (B4)**; void of a
  short-closed PO reopens + clears closure (B6); cancel blocked while a posted receipt
  exists, allowed after all voided (D5); receive non-receivable → `PO_NOT_RECEIVABLE`; empty
  → `RECEIPT_EMPTY`; trashed line ingredient → `PO_LINE_INGREDIENT_MISSING`; short-close w/o
  reason → `PO_CLOSE_REASON_REQUIRED`; **cross-PO line / cross-receipt FK rejected (B5)**;
  cross-org RLS on both tables.
- **Ledger rollback:** a mid-batch failure leaves **zero** movements **and** no receipt row.
- **RBAC `tests/receipts-authz.test.ts`:** every action `FORBIDDEN` for kitchen before data.
- **Purge `tests/trash.test.ts` (extend):** ingredient on a `receipt_items` row is kept.
- **`tests/account-export.test.ts`:** version 8; `receipts` + `receipt_items` exported, never
  another tenant's.
- **Precision `tests`:** a `1.50` canonical receipt reconciles exactly with stock + ledger
  at `numeric(12,2)` (B1 regression).
- **Real-PG `tests/concurrency/receipts.pg.test.ts`** (opt-in `TEST_DATABASE_URL`): two
  concurrent `postReceipt` on the same PO sharing an ingredient → deterministic lock order,
  no deadlock, stock = sum; retried receipt after a simulated crash does not double-apply;
  concurrent void × post ends in a single coherent terminal state.

## 9. Out of scope (later sprints)
Amend/revision of a sent PO; receiving in pack units (canonical only); three-way match /
supplier-invoice reconciliation; auto-accepting observed cost; goods-received email; landed
cost; per-storage-area receiving (Sprint 12c); a standalone PO **reopen** action (reopen is
only a void side effect in v1).

## 10. Definition of Done
- `npm run lint && npm run typecheck && npm test && npm run build` green.
- Migration `0027` applied **locally** (migrate-guard "Journal ordering OK"); prod awaits
  diff review.
- **B1:** entire stock domain reconciles at `numeric(12,2)`; PO line scale aligned.
- **F1:** receipts post idempotent IN movements (form-level D6 + ledger-level keys); a
  mid-batch failure leaves zero movements + no receipt; corrections post reversals, never
  edit a movement; void blocked when stock insufficient (B4).
- **F2:** received cost raises pending + `source='order'` history w/ receipt provenance;
  `price_cents` never silently mutated; void recompute never reverts an accepted cost (B3).
- PO rolls `sent → partially_received → received` (incl. short-close w/ reason); void
  recomputes down and reopens a short-close (B6); cancel blocked with posted receipts (D5).
- **B5:** cross-PO / cross-receipt line references are impossible at the DB layer.
- **F3** purge-block extended to `receipt_items` + `docs/document-snapshot-policy.md` updated.
- Every receipt mutation audited (no PII); account-export 7 → 8 + tested.
- `docs/sprint-8b-plan.md` committed; full diff handed to the owner before any prod migration.

## 11. Codebase anchors (reuse, don't reinvent)
- **F1 ledger:** `lib/data/inventory.ts` (`recordMovements` batch + `MovementError`,
  `buildMovementKey`; `MovementSourceType` already has `'purchase_receipt'`/`'reversal'`) ·
  append-only RLS `lib/db/rls.ts`.
- **F2 pricing:** `lib/data/ingredient-pricing.ts` (`recordPriceObservation`,
  `acceptPendingCost`; add `recordDerivedPriceObservation` + `recomputePendingAfterVoid`) ·
  `lib/calculations/purchasePrice.ts` · `ingredients.pending_price_cents`.
- **8a PO infra:** `lib/data/purchase-orders.ts` · `lib/calculations/purchaseOrder.ts` ·
  `lib/documents/snapshots.ts` (`ingredientLineSnapshot`) · `lib/validation/purchase-orders.ts`
  · schema `lib/db/schema.ts:999` (`purchaseOrders`/`purchaseOrderItems`).
- **Locking:** `lib/data/ingredients.ts` (`lockActiveIngredientRow`).
- **Purge / F3:** `lib/data/trash.ts` (`purgeExpired` `notExists` precedent) ·
  `docs/document-snapshot-policy.md`.
- **Plumbing:** `lib/data/account-export.ts` (`ACCOUNT_EXPORT_SCHEMA_VERSION` 7 → 8) ·
  `lib/data/audit.ts` · `lib/action-result.ts` · `lib/i18n/messages/en.json` ·
  `businessTables` + `rls.ts` · `drizzle/meta/_journal.json` (bump `when` for 0027).
- **Concurrency pattern:** `tests/concurrency/purchase-orders.pg.test.ts` /
  `recipe-line.pg.test.ts`.

## Verification (end-to-end)
1. `npm run db:generate`; hand-edit the status-CHECK swap + the `(12,3)→(12,2)` ALTER; apply
   `0027` **locally**; migrate-guard "Journal ordering OK".
2. `npm test` incl. new receipts/authz/purge/export/precision suites; optionally the opt-in
   `*.pg.test.ts`.
3. `npm run dev` as **manager**: `sent` PO → Receive → partial delivery → `partially_received`,
   stock rises, "pending cost — accept?" hint; accept in `/ingredients` → `price_cents`
   updates; remainder → `received`; void → stock reverses, pending recomputed; short-close a
   partial PO w/ reason → `received`; try to cancel with a posted receipt → `PO_NOT_CANCELLABLE`.
4. As **kitchen**: receive actions → `NoAccess`/`FORBIDDEN`.
5. `npm run lint && npm run typecheck && npm run build` green.
