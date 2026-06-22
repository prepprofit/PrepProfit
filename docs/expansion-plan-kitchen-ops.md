# Expansion Plan — Kitchen-Operations Parity (v2.2, post third review)

> **Status:** plan body is **v2.2** (2026-06-21). **Build progress (updated
> 2026-06-22):** **Foundation F1–F6 is COMPLETE and on `main`** (prod migrated
> through 0023), and module Sprints **9 (Allergens), 7 (Suppliers), and 8a (PO
> draft/send + outbox)** are **DONE**. See **§8** for the live per-sprint status.
> **Sprint 8b (PO receiving) is now IMPLEMENTED locally (gate green; prod migration 0027
awaits diff review). Next = Sprint 10 (Menus).** The sections below are the approved design of
> record; they are kept as-written for traceability even where the work is now done.
> Confirmed fact still relied on everywhere: `runInOrg` (`lib/db/tenant.ts`) wraps
> `database.transaction(...)`, which **commits on normal return and rolls back only
> on throw** — every "abort" path below therefore THROWS, it never just returns.

---

## 0. What changed v2.1 → v2.2 (answers to the third review)

| Item (review) | Fix in v2.2 |
|---|---|
| **§5 void divergence** | **APPROVED by dev.** Codified as a 6-point **Void retention contract** in §4 F5 (atomic+idempotent, single `withOrg`, excluded from Trash/restore/purge, sale + transaction kept indefinitely, 2nd void = no-op/`INVALID_STATUS_TRANSITION`) |
| **F1 critical: `{ok:false}` doesn't roll back `withOrg`** | §4 F1: algorithm reordered to **lock → dedup/validate → stock check → insert → update** so every early return happens **before any write**; multi-movement batches **THROW** to roll back (no partial consumption) |
| F1: same key, different payload | §4 F1: returns **`IDEMPOTENCY_CONFLICT`**, never a silent dedup |
| F1: composite self-FK target | §4 F1: add `UNIQUE (organization_id, id)`; staged migration **nullable → backfill → NOT NULL** |
| F6: `PO-####` MAX+1 not concurrency-safe | §4 F6: **dedicated per-org PO counter (FOR UPDATE)** + editable + unique `(org, number)` — not MAX+1 |
| F6: supplier transition | §4 F6: **dual-WRITE** (new imports write supplier + link AND the legacy column) during the rollback window, not dual-read only |

---

## 0b. What changed v2 → v2.1 (answers to the second review)

| # (review) | Issue in v2 | Fix in v2.1 |
|---|---|---|
| 1 | **F2 price formula wrong** (gave cents/gram, not cents/kg) | §4 F2 corrected: `approved = pack_price × PRICE_UNIT_SIZE ÷ canonical(pack)`; 1 kg/€5 → **500 c/kg**, with worked examples |
| 2 | **F1 idempotency key collapses multi-ingredient lines** | §4 F1: idempotency is a **deterministic `idempotency_key`** that includes `ingredient_id` (one explosion → many movements, each unique) |
| 3 | **`recordMovement` order aborts tx on conflict** | §4 F1: new algorithm — `INSERT … ON CONFLICT DO NOTHING` FIRST; if no row → `deduped` (no stock change); else lock + update; all one tx |
| 4 | **Reversals can duplicate** | §4 F1: partial unique `(org, reversal_of)`, composite self-FK (same org), **append-only at the DB** (RLS), not by convention |
| 5 | **Sales→Transactions inconsistent** | §4 F5: one **protected** `income` row (gross); **void soft-deletes via the controlled path** (schema has no negative amounts) — a *reasoned divergence* from the two-row idea, flagged for confirm; bank-import double-count **explicitly assumed** as a v1 limitation |
| 6 | **`document_counters` contradictory** | §4 F6: **dropped**. PO gets its own ref (**gaps allowed**, no fiscal gap-free need); sales ref = close date; productions = free text |
| 7 | **Storage areas don't reconcile** | §6.6 12c: default area + backfill + optional-area + **balance invariant** + transfer type + count per (ingredient, area) |
| — | Over-attributed owner decisions | §2: only the **5 explicitly confirmed** calls are "owner-approved"; "daily close" + "no price edit" are now confirmed (2026-06-21) |
| — | Allergen overrides too permissive | §6.1: v1 overrides may only **add / escalate** severity; removing a derived allergen is **not allowed** in v1 |
| — | Outbox under-specified | §6.3: `email_outbox` worker/cron, states, retries, provider id, dedup |
| — | External-sign-off gate contradictory | §7: external opinions **never block Foundation**; fiscal blocks **only 12a**; food-safety blocks **only legal claims**, not the operational feature |

---

## 1. Context (unchanged)

Close the kitchen-operations gap vs **ratatool** (suppliers, purchase orders,
menus, production, sales, allergens, inventory depth) additively, without weakening
the multi-tenant / RLS / audit / entitlement guarantees. v1 of this plan got a
**NO-GO**; this is the corrected line. We are **ahead** on finance, HR, AI and
security; **behind** on the kitchen operating loop. (Full have/missing inventory in
git history of this file; trimmed here for focus.)

---

## 2. Decisions LOCKED by the product owner (André)

Only decisions the owner **explicitly** made (the dev correctly flagged v2 for
asserting more than was confirmed). Each is dated; nothing else may be labeled
"owner-approved".

1. **RBAC view lockdown (2026-06-21):** kitchen sees operational recipe content
   (ingredients, quantities, steps, yield, allergens) but **no monetary figure
   anywhere**. Reverses today's behavior (`app/(app)/recipes/page.tsx` is not
   manager-gated).
2. **Kitchen cannot EDIT ingredient prices (2026-06-21):** price edit is a
   financial action → manager-only; the action returns `FORBIDDEN` before write.
3. **Sales fiscal (2026-06-21):** single configurable org VAT rate, **exclusive**
   pricing, per-item override, integer basis points, line-level round-half-up.
   No multi-jurisdiction in v1. (Accountant still signs off rounding/jurisdiction.)
4. **Sales primary format = DAILY CLOSE (2026-06-21):** a "sale" is the per-item
   day total (POS/sheet). Ticket-level is out of scope for v1.
5. **Sprint 6 reduction approved (2026-06-21):** light task model now (11c); the
   rich original Sprint 6 is formally deferred to its own later sprint.

> **Ship-safety on #1/#2:** these change what existing kitchen users see and can
> do. They ship as the explicit Foundation task **F4** (retrofit + tests + release
> note), not as a silent side effect.

---

## 3. Non-negotiable constraints + expanded Definition of Done

All `CLAUDE.md` rules hold (org-scoped queries, `getOrgId()`, `businessTables` +
forced RLS, `withOrg`, composite FKs, integer cents, pure tested calc modules, Zod,
stable `ActionErrorCode`, `writeAuditEvent` in-tx, RBAC before data, entitlements
after RBAC, soft-delete, next-intl, no `any`, migration `when` > current max).

**Per-sprint DoD adds** (from the first review): 4-way RLS tests; calc edge tests;
RBAC + entitlement tests before data; **idempotency/retry tests** (double-submit +
server retry) on every ledger/money path; **real-PG concurrency AND deadlock**
tests (shared ingredients) where applicable; **historical-snapshot** test (master
edited/purged after issue → document still correct); **GDPR**: new tables in the
account-export bundle **+ export-format `version` bumped**, purge-cron + trash +
seed/demo updated; observability + adoption metric; **rollback + backfill plan** in
the PLANO entry; nav + i18n + empty/loading/error states; ⌘K where searchable; full
gate green; PLANO ticked + prod-migration verified.

---

## 4. Sprint F — Operational Foundation (build FIRST, delivered in parts)

The shared primitives. **No business module ships before F is done and reviewed.**
Per the dev, F is larger than one sprint → delivered as **F1…F6 slices**.

### F1 — Inventory ledger: provenance, idempotency, reversal, append-only

**Columns added to `inventory_movements`** (today: `id, organization_id,
ingredient_id, delta_canonical, note, created_at`):
- `source_type text NOT NULL` ∈ `manual | purchase_receipt | production | sale |
  stock_count | adjustment | reversal | transfer | import | seed`.
- `source_id text` (order/production/sale/count id), `source_line_id text`
  (specific line) — both nullable.
- `reversal_of text` (nullable self-reference; set only on `reversal` rows).
- `idempotency_key text NOT NULL` — **deterministic**, built by the caller.

**Idempotency (fixes review #2):** the key MUST identify the component, not just the
source line, because one production/sale line explodes into many ingredient
movements. Format:
```
sourced:     "<source_type>:<source_id>:<source_line_id|'agg'>:<ingredient_id>"
manual:      "manual:<uuid>"
reversal:    "reversal:<original_movement_id>"
```
Unique: `(organization_id, idempotency_key)`. (A single text key avoids the
NULL-distinctness trap of a multi-column key when `source_line_id` is NULL for
document-level aggregated consumption.)

**`recordMovement` algorithm (fixes review #3 AND the third-review tx bug).**
Confirmed: `runInOrg` commits on normal return and rolls back ONLY on throw — so a
returned `{ok:false}` AFTER a write would COMMIT an orphan movement. The safe order
does **all validation BEFORE any write**, so every early return is a no-op commit:
1. `SELECT … FOR UPDATE` the active same-org ingredient. Missing/trashed →
   `{ ok:false, reason:'not_found' }`. **Nothing written yet** → safe.
2. **Dedup lookup** by `(organization_id, idempotency_key)`. If a row exists, compare
   `ingredient_id`, `delta_canonical`, `source_type`, `source_id` — identical →
   `{ ok:true, deduped:true }` (no stock change); **different payload →
   `{ ok:false, reason:'idempotency_conflict' }`** (never a silent dedup).
3. **Stock check:** `stock + delta < 0` → `{ ok:false, reason:'insufficient_stock' }`.
   **Nothing written yet** → safe.
4. `INSERT` the movement `ON CONFLICT (organization_id, idempotency_key) DO NOTHING
   RETURNING id`.
5. **No row returned** (a concurrent tx won the key — and because the lock is
   per-INGREDIENT but the key is per-ORG, this CAN happen when the same key was used
   for a *different* ingredient): **re-fetch the winning movement and compare the
   full immutable payload** (ingredient_id, delta_canonical, source_type, source_id,
   source_line_id, reversal_of). Identical → `{ ok:true, deduped:true }`; any
   difference → `{ ok:false, reason:'idempotency_conflict' }`. Do **not** touch stock.
6. Row inserted → `UPDATE` stock; return `{ ok:true, ingredient }`.

**Batch consume contract (production 11b / sale 12a) — the other half of the tx
bug.** Consuming N ingredients in one `withOrg`: lock all N (deterministic **id-asc**
order, anti-deadlock), then apply. If ANY fails validation, the batch **THROWS a
typed domain error** so the whole `withOrg` rolls back — a per-call `{ok:false}` is
NOT enough (earlier movements are already committed → partial consumption). The
action wraps `withOrg` in try/catch and maps the throw to the stable code. Test: a
mid-batch `insufficient_stock` leaves **zero** movements.

**Error codes:** `IDEMPOTENCY_CONFLICT` (new), `INSUFFICIENT_STOCK` (existing),
`INVALID_STATUS_TRANSITION` (F5 double-void).

**Reversal (fixes review #4):** never update/delete a movement; insert an
equal-and-opposite row with `source_type='reversal'`, `reversal_of=<orig>`. Add
**partial unique `(organization_id, reversal_of) WHERE reversal_of IS NOT NULL`**
(a movement can be reversed at most once) and a **composite self-FK
`(organization_id, reversal_of) → (organization_id, id)`** (same-org, referent
exists).

**Append-only at the DB (fixes review #4):** move `inventory_movements` to the
append-only RLS set in `lib/db/rls.ts` (SELECT+INSERT only, like `audit_log`) — no
UPDATE/DELETE policy, so under FORCE RLS those match zero rows. Reversals/
corrections are inserts, so this is compatible. **Verified-safe with purge:** FK
referential-action (`ON DELETE CASCADE`) deletes are *not* subject to child-table
RLS, so purging an ingredient still cascade-deletes its movements; the seed deletes
ingredients (movements fall by cascade), so seeding is unaffected. A test asserts:
manual UPDATE/DELETE blocked, cascade purge works.

**Constraints:** `UNIQUE (organization_id, id)` (target for the composite self-FK),
unique `(organization_id, idempotency_key)`, the partial reversal unique + self-FK
above, traceability index `(organization_id, source_type, source_id)`.
**Staged migration (review #3, third round):** (1) add `source_type` +
`idempotency_key` **NULLABLE** + the other columns; (2) **backfill** existing rows
(`source_type='seed'`/`'manual'`, `idempotency_key='legacy:'||id`); (3) `ALTER … SET
NOT NULL`; (4) add the unique/self-FK constraints; (5) switch RLS to append-only.
Each step is its own migration (every `when` bumped past the current max).
**Tests:** double-apply same key → one movement + stock moved once; **same key,
different payload → `IDEMPOTENCY_CONFLICT`**; **`INSUFFICIENT_STOCK` leaves NO orphan
movement**; batch mid-failure → zero movements; reversal nets to prior balance;
reversed-twice rejected; manual UPDATE/DELETE blocked but cascade purge works;
concurrency + deadlock (shared ingredient).

**MANDATORY acceptance criteria (dev authorization of F1, 2026-06-21):**
1. **Post-conflict payload revalidation (step 5 above):** after `ON CONFLICT DO
   NOTHING` returns no row, fetch the winning movement and compare the **full
   immutable payload** (ingredient, delta, source_type/id/line, reversal_of) — equal
   → `deduped`, different → `IDEMPOTENCY_CONFLICT`. This catches the same key
   accidentally reused for a different ingredient (per-org key vs per-ingredient lock).
2. **Manual mutation id is CLIENT-generated, stable across retry/double-click.** A
   manual stock movement's `idempotency_key = "manual:<mutationId>"` where
   `mutationId` is a UUID created **once on the client** and resent on retry — the
   server must **not** mint a new UUID per call (that gives no idempotency). The test
   must exercise the **action flow** (submit the action twice with the same client
   mutationId → one movement), not just call `recordMovement` twice with a
   test-built key.

**Delivery conditions (F1):** migration applied **LOCALLY only** (prod waits for the
diff review); a **real-PG** concurrent test for *same key / different payload*;
**full-rollback**, **duplicate-reversal**, and **append-only RLS** tests; `npm run
lint && npm run typecheck && npm test && npm run build` green; **full diff reviewed
before F2 is authorized**.

### F2 — Canonical unit & purchase-price model (fixes review #1)

`ingredients.price_cents` is the **approved cost per PRICED unit** (per kg / litre /
piece) — exactly what `recipeCost.ts` consumes (`lineCost = price × qty ÷
CANONICAL_PER_PRICE_UNIT`, where that constant = **1000** weight/volume, **1** count).

Supplier links carry the **pack**: `pack_size`, `pack_unit`, `pack_price_cents`.
Let `PRICE_UNIT_SIZE = CANONICAL_PER_PRICE_UNIT[dimension]` (1000 or 1) and
`canonicalPack = toCanonical(pack_size, pack_unit)` (grams/ml/count). Then:

```
approvedPriceCents = round( pack_price_cents × PRICE_UNIT_SIZE ÷ canonicalPack )
```

Worked (proves the v2 bug is gone):
- 1 kg @ €5 → 500 × 1000 ÷ 1000 = **500 c/kg** ✓ (v2 wrongly gave 0.5)
- 5 kg @ €20 → 2000 × 1000 ÷ 5000 = **400 c/kg** ✓
- 500 ml @ €2 → 200 × 1000 ÷ 500 = **400 c/l** ✓
- 12 pcs @ €3 → 300 × 1 ÷ 12 = **25 c/piece** ✓

Pure `lib/calculations/purchasePrice.ts` with this one function + tests (each
dimension, `canonicalPack=0` guard, rounding boundaries). **Approved-cost flow:**
changing `ingredients.price_cents` is an explicit, audited manager action ("accept
new cost"); receiving/quotes update the supplier-link price + `ingredient_price_
history` and raise a `cost_change` flag, but **never** mutate `price_cents` silently.

### F3 — Snapshot / purge / reversal policy
Documents (orders, sales, productions + their PDFs) store **immutable snapshots** of
what they depend on at issue/post time (supplier name/address/tax id on a sent PO;
ingredient name + unit cost per line; recipe name + portion cost per production
line). Reads render the snapshot, not the live master. A master referenced by any
**non-draft** document is **purge-blocked** (archive instead); draft-only refs may
purge after nulling the link. `ingredient_price_history` is retained until full
ingredient purge. (Mirrors the existing invoice/customer snapshot pattern at
`schema.ts:397`.)

### F4 — RBAC money-visibility matrix + retrofit (implements §2.1/§2.2)

Server-enforced (not UI-hidden):

| Surface | Kitchen | Manager |
|---|---|---|
| Recipes | name, ingredients, qty, steps, yield, allergens | + cost, margin, selling price |
| Ingredients | name, category, supplier name, stock, allergens | + unit price, **edit price** |
| Inventory | quantities, storage, use-by | + stock value |
| Menus | composition, allergens | + price, food-cost %, margin |
| Suppliers / Orders / Sales / Financials / Payroll | no access | full |
| Production plan | full (operational) | + costs |
| Kitchen tasks | full | full |

**Retrofit existing screens:** strip cost/margin/selling price from kitchen views
of recipes/ingredients/inventory; gate ingredient-price edit with `isManager`
(`FORBIDDEN` before write). RBAC tests prove a kitchen user gets no monetary field
and cannot edit price. Release note + in-app notice (behavior change, owner-approved).

### F5 — Fiscal model + Sales→Transactions contract (fixes review #5)

**Tax:** `organization_settings.default_tax_rate_bps integer` (e.g. 2300 = 23%).
Sale lines carry `tax_rate_bps` (defaults from org, per-item override). **Exclusive**:
store `net_cents`, `tax_cents`, `gross_cents` separately per line and per sale. Pure
`lib/calculations/tax.ts`: `lineTax(net, bps)` round-half-up **per line**; sale total
= Σ line grosses (no re-round). Invoices keep their decimal-% model (untouched).

**Sales → Transactions (single revenue source):**
- `transactions` gains `source_type text` + `source_id text` (nullable). Posting a
  sale inserts **one** `income` row with `amount_cents = GROSS total` (matches the
  existing positive-magnitude + `type` model at `schema.ts:347,357`). Unique partial
  `(organization_id, source_type, source_id) WHERE source_type IS NOT NULL` → a sale
  posts at most once (dedup).
- **Protected:** the generated row's update/delete actions refuse when
  `source_type='sale'` (stable code); only the sale lifecycle may touch it.
- **Void (divergence APPROVED by dev):** voiding a sale **soft-deletes the linked
  transaction via the controlled void path** (no `expense`-typed reversal row that
  would distort reports; inventory still reverses by opposite-insert per F1 — the two
  ledgers differ by design). The approval came with a **6-point retention contract**:
  1. `posted → void` is **atomic + idempotent**, in a **single `withOrg`**.
  2. Sale status flip + transaction soft-delete + **stock reversals (F1)** + audit
     all commit in that **same `withOrg`** (throw-to-rollback on any failure).
  3. Sale-originated transactions are **excluded from Trash** and are **not
     restorable/editable manually** — the restore/edit/delete actions refuse rows
     with `source_type='sale'` (stable code).
  4. The **auto-purge cron SKIPS** sale-originated transactions — they are a
     permanent historical projection of the voided sale, never garbage-collected.
  5. The **voided sale row is retained indefinitely** with its original values.
  6. A **second void is a no-op or `INVALID_STATUS_TRANSITION`** (guard on
     `status='posted'` before reversing) — **never a second stock reversal**; F1
     idempotency keys are the backstop.
- **Bank-import double-count — explicit v1 limitation (per review #5):** the unique
  key stops posting the *same sale* twice; it does **not** stop a user *also*
  importing the same revenue from a bank statement. v1 **accepts this** and warns in
  the UI ("Sales post revenue automatically — don't also import it from bank").
  Reconciliation is deferred to a later sprint.

**Financial-only mode:** `organization_settings.stock_control_start_date` (nullable);
sales/productions dated **before** it post revenue/cost but **do not move stock** (so
importing history can't wreck on-hand). F5 ships the columns, the protected-transaction
guard, the void path, and the pure tax module; Sales UI consumes them in 12a.

### F6 — Shared infra: PO reference, backfill, DoD wiring (fixes review #6)
- **No generic `document_counters`. PO uses a DEDICATED per-org counter (fixes
  review, round 3):** `MAX+1` is **not** concurrency-safe even with gaps allowed, so
  PO numbers come from a dedicated `po_counters(organization_id, next_value)` row
  taken `FOR UPDATE` (same proven mechanism as `invoiceCounters`, just not required
  to be gap-free — a rolled-back tx may skip a number, which is fine for POs). The
  reference is **editable** with unique `(organization_id, number)`. Sales reference
  = the close date (`(organization_id, sale_date)` for daily close). Productions =
  free text. `invoiceCounters` stays untouched.
- **Supplier transition = DUAL-WRITE (fixes review, round 3), not dual-read only:**
  during the rollback window, the import path **creates/updates the `suppliers` row +
  `ingredient_suppliers` link AND keeps writing the legacy `ingredients.supplier`
  column**, so a rollback to pre-Sprint-7 code still has correct data. Backfill stays
  idempotent: dedup key `lower(trim(name))` per org (unique partial index); existing
  `ingredients.supplier` text → a `suppliers` row + default link;
  `ingredients.price_cents` unchanged. The legacy column is dropped only in a later
  sprint, after the window closes.
- Wire the DoD additions (GDPR export registry hook, purge-cron registry, seed/demo
  helpers) so later sprints just register their tables.

### Effort: **L+, delivered in parts (F1…F6).** Riskiest: F1 ledger migration on live
data + the F4 product change. F de-risks everything after it.

---

## 5. Revised sequencing

```
Sprint F (F1…F6)   ← gate: dev signs §4; delivered in parts
  └─► 9    Allergens (operational; independent; low-risk opener)
      └─► 7    Suppliers (F2 pricing, F6 backfill)
          └─► 8a   PO draft + send (supplier snapshot, outbox email)
              └─► 8b   PO receiving (receipt/receipt_items, F1 idempotent ledger)
                  └─► 10   Menus (money manager-only per F4)
                      └─► 11a  Production planning + explosion
                          └─► 11b  Production completion → consume (F1)
                              └─► 11c  Kitchen tasks (reduced model)
                                  └─► 12a  Sales: daily close (F5)
                                      └─► 12b  Sales import
                                          └─► 12c  Inventory depth (storage/use-by/counts)
```

---

## 6. Module sprints (Foundation primitives assumed)

### 6.1 Sprint 9 — Allergens (operational; NOT a legal claim)
- EU-14 static const + `ingredient_allergens` (`presence: contains|may_contain`,
  unique per ingredient+code) + `recipe_allergen_overrides`.
- **v1 overrides may only ADD an allergen or ESCALATE severity** (`may_contain →
  contains`). **Removing or downgrading a derived allergen is NOT allowed in v1**
  (would need justification + review + audit; deferred) — safer for food safety.
- Review provenance (`reviewed_by`, `reviewed_at`). Calc `allergens.ts` (union +
  strongest presence + additive overrides). Matrix export (XLSX/PDF), **kitchen-
  allowed**. **No "legally compliant" claim** — copy says "operator remains
  responsible"; legal review = §7. Effort **S–M**, low risk. Best opener after F.

### 6.2 Sprint 7 — Suppliers (single default v1)
`suppliers`, `ingredient_suppliers` (pack_size/pack_unit/pack_price_cents,
`is_default` partial-unique; derived cost via **F2**), `ingredient_price_history`.
Backfill per **F6** (idempotent). `ingredients.supplier` deprecated → dual-read →
dropped later. Manager-only (F4). `procurement` feature (Pro+) gates multi-supplier
UI + Orders; supplier entity + default cost available all plans (costing needs it).
Audit + ⌘K (manager-only) + purge per F3. Effort **M–L**.

### 6.3 Sprint 8 — Purchase Orders (split)
**8a — Draft + Send:** `purchase_orders` (ref per F6 gaps-allowed; status
`draft|sent|cancelled`; **supplier snapshot frozen on send** per F3),
`purchase_order_items` (own `id`, **canonical qty**, ordered unit cost). Editable
only in `draft`; a `sent` order changes via an explicit **amend** action (no silent
edit — resolves the v1 contradiction). PO PDF (snapshot).
**Email via `email_outbox`** (not in the DB tx): the send action commits the PO +
enqueues one outbox row in the same tx; a **cron worker** (reuse cron-auth +
rate-limit) processes `pending` rows with backoff. Outbox columns: `status
(pending|sending|sent|failed)`, `attempts`, `max_attempts`, `last_error`,
`provider_message_id`, `dedup_key` (unique per org). **Idempotent:** never resend a
row that already has `provider_message_id`; audit `document.email` only after the
provider accepts; exhausted attempts → `failed` (surfaced in UI).

**8b — Receiving:** `receipts` + `receipt_items` (multiple **partial deliveries**),
each with received qty + **received unit price**. Receiving writes **idempotent** IN
movements via **F1** (`source_type='purchase_receipt'`, key includes
`receipt_item.id` + `ingredient_id`); updates supplier-link price +
`ingredient_price_history` (`source='order'`) and raises the F2 `cost_change` flag
(never auto-updates `ingredients.price_cents`). Status `partially_received|received`;
closing below order needs a reason. **Corrections are manager-only and post a
reversal (F1) + a new receipt** (never edit a movement). Real-PG concurrency +
deadlock + retry tests. Effort **L** each.

### 6.4 Sprint 10 — Menus / Combos
`menus` + `menu_items` (recipes-only v1). Calc reuses `recipeCost.ts` + `margin.ts`.
Per F4: kitchen sees composition + allergens; **price/food-cost/margin manager-only**
(server-enforced). All plans; ⌘K. Effort **M**, low risk.

### 6.5 Sprint 11 — Production (split) + Kitchen tasks
**11a — Planning + explosion:** `productions` (reference = **free text**, not
gap-free), `production_items` (**`planned_qty` = portions**). Calc `production.ts`:
per ingredient, `canonical_needed = recipe_line.quantity × (planned_qty /
yieldPortions) ÷ (yieldPercentage/100)` — mirrors `recipeCost.ts` yield math —
aggregated across items per ingredient, rounded `numeric(12,2)`. **Single-level only;
sub-recipes are OUT of scope** and a test asserts the explosion does not recurse
(resolves the v1 self-contradiction). `shortfallVsStock` flags what to order.

**11b — Completion → consume:** writes **idempotent** OUT movements (F1,
`source_type='production'`, key includes `production_id` + `ingredient_id`); respects
insufficient-stock reject and the F5 stock-control start date; produced recipes are
**not** stockable in v1. **Deterministic lock order** (ingredients locked by id asc)
to avoid deadlocks; deadlock test required.

**11c — Kitchen tasks (reduced, §2.5):** `kitchen_tasks` (`production_id` nullable,
`assignee_user_id` nullable, title, due_at, done_at, position). Kitchen-visible +
editable. Rich Sprint 6 stays deferred.

### 6.6 Sprint 12 — Sales (split) + Inventory depth
**12a — Sales, DAILY CLOSE (§2.4, F5):** `sales` (status `draft|posted|void`,
`net_cents`/`tax_cents`/`gross_cents`, post/void timestamps; reference = close date),
`sale_items` (recipe/menu/ingredient ref, units, unit price, `tax_rate_bps`,
net/tax/gross). Posting writes the protected linked `income` transaction (F5) **and**
idempotent OUT stock movements (F1) when dated ≥ stock-control start. **Void**
soft-deletes the transaction via the controlled path (F5) + posts reversal movements
(F1). Pro+ (`sales`).

**12b — Sales import:** staged (reuse `lib/import`); dedup on a stable external key +
`(source_type, source_id)`; **financial-only** for pre-start-date rows (no stock
move); double-commit guard; injection-safe. Effort **L**.

**12c — Inventory depth (fixes review #7):**
- `storage_areas` (org, name, `is_default`; seed one "Main" default per org).
- `inventory_movements` gains `(organization_id, storage_area_id)` **nullable** —
  NULL = the org default area. **Backfill:** existing rows → NULL (= default).
- New movements: area **optional** in v1 (defaults to the org default) — not forced
  on every receipt/sale.
- **Balance invariant (the reconciliation the review demanded):**
  `ingredients.stock_quantity == Σ ALL movements (every area incl. default/NULL)`;
  per-area balance = Σ movements for that area; total = Σ areas, so they reconcile.
- **Transfers** between areas = a pair of movements (`source_type='transfer'`, out
  of A + into B) that nets zero at ingredient level.
- **Physical count per (ingredient, area):** `stock_counts` + `stock_count_items`
  keyed by area; commit posts area-specific **adjustment** movements (F1) to
  reconcile counted vs ledger. Effort **M**.

---

## 7. External sign-offs (do NOT block Foundation)

- **Foundation (F) is NOT gated by any external opinion** — it is internal
  plumbing; build it once the dev signs §4.
- **Accountant** confirms line-level **rounding** + exclusive model + single-rate
  adequacy for the jurisdiction → blocks **only Sprint 12a**.
- **Food-safety/legal** reviews the allergen declaration (cereal/nut subtypes,
  cross-contamination wording, language, operator-responsibility disclaimer) →
  blocks **only a compliance CLAIM**, NOT the operational allergen feature (Sprint 9
  ships without the claim).

---

## 8. Per-sprint status (updated 2026-06-22)

| Sprint | Module | Status | Gate before start |
|---|---|---|---|
| **F1–F6** | Operational Foundation (full) | **✅ DONE — merged to `main`** | — (prod migrated through 0023) |
| 9 | Allergens (operational) | **✅ DONE** (`07d7d28`) | — |
| 7 | Suppliers | **✅ DONE** (`6773d3f`) | — |
| 8a | PO draft/send + outbox | **✅ DONE** (`0585cf5`) | — |
| 8b | PO receiving | **✅ IMPLEMENTED locally** (gate green; awaiting diff review for prod migration 0027) | F1 done ✅ |
| 10 | Menus | 🟢 after F4 ✅ | — |
| 11a | Production planning | 🟡 | planned_qty=portions confirmed |
| 11b | Production consume | 🟡 | F1 done ✅ + deterministic lock |
| 11c | Kitchen tasks (reduced) | 🟢 | reduction in PLANO |
| 12a | Sales (daily close) | 🟡 | F5 done ✅ + accountant sign-off (§7) |
| 12b | Sales import | 🟡 | dedup + financial-only |
| 12c | Inventory depth | 🟡 | balance invariant accepted |

**Bottom line:** **Foundation (F1–F6) is COMPLETE and on `main`** (prod migrated
through 0023). Sprints **9 (Allergens), 7 (Suppliers), and 8a (PO draft/send + email
outbox)** are also **DONE**. **Next = Sprint 8b (PO receiving)**, which the completed
F1 idempotent ledger unblocks. Remaining work: 8b → 10 → 11a → 11b → 11c → 12a →
12b → 12c. §7 external sign-offs still gate only their named sprints (accountant →
12a; food-safety/legal → only an allergen compliance *claim*, not the shipped feature).

---

## 9. F1 implementation pre-flight (codebase recon, captured 2026-06-21)

Exact impact map so the implementation session starts cold-but-fast. F1 scope is
**small and contained**: the ledger primitive + its few callers.

### Files to CHANGE
- **`lib/db/schema.ts`** (`inventoryMovements`, ~line 269): add `sourceType`
  (text, NOT NULL), `sourceId` (text, null), `sourceLineId` (text, null),
  `reversalOf` (text, null), `idempotencyKey` (text, NOT NULL). Add: `unique
  (organization_id, id)` (self-FK target), `unique (organization_id,
  idempotency_key)`, partial unique `(organization_id, reversal_of) WHERE
  reversal_of IS NOT NULL`, composite self-FK `(organization_id, reversal_of) →
  (organization_id, id)`, index `(organization_id, source_type, source_id)`.
  Schema reflects the FINAL (NOT NULL) state; the migration stages the backfill.
- **`lib/data/inventory.ts`** (`recordMovement`): rewrite to the §4 F1 algorithm
  (lock → dedup pre-check → stock check → `INSERT … ON CONFLICT DO NOTHING
  RETURNING` → **post-conflict full-payload revalidation** → update). Extend
  `RecordMovementInput` with `source` (`{type, id?, lineId?}`), optional
  `reversalOf`, and an `idempotencyKey` (or a `buildKey` helper). Add
  `'idempotency_conflict'` to `RecordMovementResult.reason`. Add a `deduped?: true`
  flag on the ok arm. Keep the `FOR UPDATE` + insufficient-stock reject.
- **`lib/db/rls.ts`**: change `APPEND_ONLY_TABLE` (single string) → a **set** incl.
  `'inventory_movements'`. `appendOnlyPolicy` already drops the generic
  `org_isolation` first, so the switch is idempotent. (`npm run db:migrate` re-applies
  all `rlsStatements` after migrating.)
- **`lib/action-result.ts`**: add `'IDEMPOTENCY_CONFLICT'` to `ActionErrorCode`.
- **`lib/i18n/messages/en.json`**: add `actionErrors.IDEMPOTENCY_CONFLICT` (ONLY
  locale file — confirmed single-locale today).
- **`lib/validation/inventory.ts`** (`movementSchema`): add `mutationId`
  (`z.string().uuid()`) — the CLIENT-generated stable id (mandatory criterion #2).
- **`app/(app)/inventory/actions.ts`** (`recordMovementAction`): pass
  `source:{type:'manual'}` + `idempotencyKey="manual:"+mutationId`; map
  `idempotency_conflict → 'IDEMPOTENCY_CONFLICT'` (currently only maps
  insufficient_stock/NOT_FOUND).
- **`components/app/inventory/inventory-panel.tsx`**: generate a UUID **once per
  form instance** (`useRef(crypto.randomUUID())`), send it as `mutationId`, and
  **rotate it only after a successful submit** so a double-click/retry reuses the
  same id (idempotent) but a new intentional movement gets a fresh id.
- **`scripts/seed-demo.ts`** (calls `recordMovement`): pass
  `source:{type:'seed'}` + a deterministic key (e.g. `"seed:"+ingredientId+":"+i`).

### Files to CREATE
- **The migration** (`npm run db:generate` → will be `0020`): then **hand-edit the
  generated SQL** into the staged form (drizzle can't author the backfill):
  1. `ALTER TABLE … ADD COLUMN` all new columns **nullable**;
  2. `UPDATE inventory_movements SET source_type='seed', idempotency_key='legacy:'||id
     WHERE source_type IS NULL`;
  3. `ALTER … ALTER COLUMN source_type SET NOT NULL`, same for `idempotency_key`;
  4. `ADD CONSTRAINT` the uniques + self-FK + index.
  Statements separated by `--> statement-breakpoint`. **Verify `_journal.json`
  `when` > current max applied `created_at`** (the recurring gotcha; `migrate-guard`
  will also abort if not). Apply **LOCALLY only** (`npm run db:migrate` against the
  local/dev DB) — **prod waits for the diff review**.
- **`tests/inventory-idempotency.test.ts`** (PGlite): action called twice with the
  same `mutationId` → ONE movement + stock moved once; second `recordMovement` with
  same key + identical payload → `deduped`, no stock change; manual UPDATE/DELETE of
  a movement blocked by append-only RLS but ingredient cascade-purge still deletes
  movements; `INSUFFICIENT_STOCK` leaves **zero** movements (orphan test); batch
  mid-failure throws → zero movements; reversal nets to prior balance; second
  reversal of the same movement rejected.
- **`tests/concurrency/inventory-idempotency.pg.test.ts`** (real-PG, mirror
  `recipe-line.pg.test.ts`: `describe.skipIf(!TEST_DATABASE_URL)`, neon-serverless
  `Pool` + `ws`, `Promise.all` of two `runInOrg`): **same key / DIFFERENT payload**
  raced across two ingredients → exactly one inserts, the other gets
  `IDEMPOTENCY_CONFLICT` (proves the per-org-key vs per-ingredient-lock hole is
  closed). Needs a disposable Neon branch with migrations+RLS applied.

### Gotchas captured
- `runInOrg` = `database.transaction(...)` → **commit on return, rollback only on
  throw**. Single `recordMovement` validates before writing (safe to return);
  **batch consumers must throw**.
- Per-org idempotency key + per-ingredient lock ⇒ the post-`ON CONFLICT`
  revalidation is **mandatory**, not defensive.
- Only one i18n locale file today; build trips on Google Fonts without network
  (cosmetic — not a code failure).

### Done = delivery conditions (§4 F1)
Local migration only; real-PG same-key/different-payload test; full-rollback +
duplicate-reversal + append-only-RLS tests; `npm run lint && npm run typecheck &&
npm test && npm run build` green; **full diff handed to the dev before F2**.
