# Sprint 11b — Production completion + stock posting — implementation plan

> **Status: IMPLEMENTED LOCALLY — full gate green (lint + typecheck + test + build).**
> §1.B decisions signed off: D1 = BOTH roles may complete; D2–D8 = the recommended
> defaults. Migration `0030` (`0030_cooing_shriek.sql`) is generated + applied to the
> PGlite test DB ONLY — it is **NOT** committed/pushed and has **NOT** reached
> production. Prod migration awaits explicit owner authorization (diff-review gate).
> Builds directly on the shipped Sprint 11a (`docs/sprint-11a-production-plan.md`,
> `lib/data/productions.ts`, `lib/calculations/production.ts`). Source of truth for
> the inventory contract: Sprint F1 (`lib/data/inventory.ts`), the goods-receipt
> post/void precedent (Sprint 8b, `lib/data/receipts.ts`), and the financial-only
> stock-control rule (Sprint F5, `lib/finance/stock-control.ts`). Migration `0030`
> is **LOCAL only** until its generated SQL/meta diff is reviewed and the owner
> explicitly authorizes production.

## 0. Outcome and non-negotiable boundaries

11b owns the single critical transition **`planned → completed`**, plus its inverse
correction **`completed → voided`** (by reversal). Completing a production:

1. **freezes** a server-built snapshot of the exploded ingredient requirement and the
   per-recipe/per-portion cost — so the historical document never moves again, even if
   recipes, ingredient prices or stock later change;
2. posts **idempotent F1 OUT movements** (one per ingredient) that consume stock
   through the authoritative ledger; and
3. makes the row **permanent history** — completed/voided productions are excluded
   from Trash and from auto-purge, and can only change by an explicit void.

11b is **posting**, not planning. It introduces no new costing formula and no new
explosion math — it reuses 11a's `explodeProduction` / `componentCost` to BUILD the
snapshot once, under lock, inside the completing transaction, then stores the result.

Hard invariants (carried from 11a + the ledger contract):

- The ledger stays authoritative: a completion that would drive any ingredient below
  zero is **rejected and rolled back whole** — never clamped, never partial (F1).
- Money stays manager-only. The frozen snapshot carries cost columns, but the kitchen
  loaders never select them (F4 by construction, key absence — same as 11a).
- A completion never edits a movement; a void is an **equal-and-opposite insert**
  (`source_type='reversal'`, `reversal_of` → the original), mirroring `voidReceipt`.
- Idempotency: re-submitting the same completion/void (retry/double-click) applies
  movements **exactly once** via deterministic keys. A terminal retry is an explicit
  ok/no-op only after the already-written artifacts are present; it never audits a
  second time.

---

## 1. Decisions

### 1.A — Locked (inherited from 11a / the ledger, restated for context)

1. **L1 — One transition owner.** Only `planned → completed` and `completed → voided`
   live here. `draft ⇄ planned`, soft-delete/restore/purge and the explosion stay as
   shipped in 11a; this sprint does not touch them except to forbid trashing a
   completed/voided row (§2).
2. **L2 — Movement provenance.** OUT movements use the existing `source_type =
   'production'`, `source_id = production.id`; reversals use `'reversal'` with
   `reversal_of`. The `production` source type and `recordMovements` batch helper
   already exist and already name 11b (`lib/data/inventory.ts`).
3. **L3 — Insufficient stock is a hard block.** `recordMovements` THROWS
   `MovementError('insufficient_stock')` on the first shortfall, so the whole
   `withOrg` rolls back: no snapshot, no movement, status unchanged. Mapped to the
   existing `INSUFFICIENT_STOCK` action code.
4. **L4 — Snapshot, not re-derivation.** A completed production reads its FROZEN
   snapshot, never live `recipeCost`/`explodeProduction`. Changing an ingredient
   price/stock or trashing a recipe afterwards never alters a completed document.
5. **L5 — Permanent history.** Completed and voided productions are excluded from
   soft-delete, Trash and auto-purge (mirrors issued invoices / sale-sourced
   transactions). They keep pinning their recipes via the existing
   `production_items → recipes` restrict FK from 11a.

### 1.B — To confirm with senior review (proposed defaults in **bold**)

> These are the genuine design choices. Each has a recommended default so a "no
> changes" review is a valid approval.

- **D1 — Who may complete?** A completion posts stock movements AND freezes a cost
  snapshot.
  - **Recommended: BOTH roles may complete** (it is the operational close-out of a
    prep run; the cost snapshot is frozen server-side and withheld from the kitchen
    DTO, exactly like the 11a cost). Kitchen already creates/plans/reopens (11a D7).
  - Alternative: manager-only (symmetry with goods-receipt posting, which is
    manager-only in 8b). *Pick one — this drives the action's RBAC guard.*
- **D2 — Who may void?** A void reverses stock and the cost snapshot — a correction.
  - **Recommended: manager-only** (corrections/financial reversals are manager
    territory, mirroring `voidReceipt`). Restore/purge are already manager-only.
- **D3 — Snapshot shape.** Proposed: two immutable child tables plus frozen
  completion/lifecycle columns on `productions` (§3). Confirm the table split vs. a
  single flattened snapshot.
  - **Recommended: two tables** (`production_recipe_snapshots` per recipe line,
    `production_consumptions` per ingredient) + `completed_at`/`voided_at`/
    `cost_total_cents`/`stock_moved` on `productions`. Rationale: the
    per-ingredient consumption is the natural unit for the F1 movement link and the
    kitchen mise-en-place readout; per-recipe cost is the natural unit for the manager
    cost card; `stock_moved` freezes the F5 posting decision.
- **D4 — Which date drives stock-control?** `movesStock(eventDate, startDate)` needs
  an event date.
  - **Recommended: `planned_for`** (the production's planned date is its event date).
    A production dated before the org's `stock_control_start_date` completes and
    freezes its cost snapshot but posts **no** OUT movements (`stock_moved = false`),
    so importing historical prep can't wreck current on-hand. Evaluated at completion
    time only (never re-derived), per F5.
- **D5 — Movement granularity / key.** The explosion aggregates per ingredient, so
  completion posts **one OUT movement per ingredient** (not per recipe line).
  - **Recommended key:** `buildMovementKey('production', productionId, null,
    ingredientId)` → `"production:<id>:agg:<ingredientId>"`. Aggregated consumption,
    `source_line_id = null`. This is exactly the `'agg'` fallback the helper documents.
    Because `production_consumptions.movement_id` stores the posted ledger row, 11b
    must either extend `recordMovement(s)` to return movement ids on both insert and
    dedupe (recommended) or fetch the rows by idempotency key after a successful post.
- **D6 — Ingredient purge pin.** An ingredient consumed by a completed production has
  permanent ledger history (`inventory_movements` cascade-delete with the ingredient).
  - **Recommended: add a `production` movement pin to both manual ingredient purge and
    `purgeExpired`** (mirrors the existing `receiptPin`): an ingredient with any
    surviving `production`-sourced movement is KEPT, never hard-purged — so completed
    history is never silently lost. Financial-only completions with
    `stock_moved=false` have no ledger movement; their snapshot carries ingredient
    name/dimension and intentionally does not pin the live ingredient.
- **D7 — Void floor.** Reversing an OUT movement ADDS stock back (positive delta), so
  it can never breach the zero floor — unlike a receipt void. **Recommended: void is
  always allowed for a completed production** (no insufficient-stock block on void).
- **D8 — Re-completion of a voided run.** **Recommended: a voided production is
  terminal** (no `voided → *`). To run it again, create a new production (cheap,
  reference-copyable later). Keeps the lifecycle a DAG and the idempotency keys stable.

---

## 2. State machine and edit contract

```text
draft ⇄ planned            (11a — unchanged)
planned ─► completed       (11b — posts stock + freezes snapshot, under lock)
completed ─► voided        (11b — posts reversals, retains the row)

completed / voided: PERMANENT. No soft-delete, no Trash, no auto-purge, no reopen.
```

- **Complete:** `planned → completed`. Requires the live explosion and manager cost
  derivation to still be COMPLETE under lock (all recipes and consumed ingredients
  active, finite in-domain math, non-null total cost) and `planned_for` set —
  re-checked at completion, never trusted from the plan step. Builds the snapshot,
  posts OUT movements (subject to D4 stock-control + L3 floor), stamps
  `completed_at`. A retry against an already completed row returns ok/no-op only
  after verifying the frozen snapshot exists; it writes and audits nothing.
- **Void:** `completed → voided`. Posts an F1 reversal per OUT movement, stamps
  `voided_at`. If `stock_moved=false`, there are no movements to reverse; the void
  only stamps the lifecycle correction. Idempotent: voiding an already-voided run is
  an ok/no-op and audits nothing.
- **Forbidden:** completing a non-planned row → `PRODUCTION_NOT_COMPLETABLE`; voiding
  a non-completed row → `PRODUCTION_NOT_VOIDABLE`; editing/reopening/trashing a
  completed/voided row → `PRODUCTION_NOT_EDITABLE` for edits/reopen and
  `PRODUCTION_NOT_DELETABLE` for soft-delete.
- **Optimistic concurrency:** complete/void carry `expectedUpdatedAt`, lock the row
  `FOR UPDATE`, and compare before mutating an eligible source state (`planned` for
  complete, `completed` for void). Terminal idempotent retries are handled as no-ops
  first; non-terminal stale rows return `PRODUCTION_STALE` before any write/movement.

---

## 3. Data model — migration `0030`

Set journal `when` above the current maximum (0029 = 1782194394650). Add the new
tables to `businessTables`, standard `org_isolation` RLS, account export, and bump the
export schema version **10 → 11**.

### `productions` (alter)

- widen `CHECK status IN ('draft','planned')` → `('draft','planned','completed','voided')`;
- `completed_at timestamptz NULL`;
- `voided_at timestamptz NULL`;
- `cost_total_cents integer NULL` (frozen total at completion; manager-only on read);
- `stock_moved boolean NOT NULL DEFAULT false` (was the org in stock-control at the
  event date — D4).
- CHECKs:
  - `completed_at IS NOT NULL` iff `status IN ('completed','voided')`;
  - `voided_at IS NOT NULL` iff `status = 'voided'`;
  - `cost_total_cents IS NOT NULL` iff `status IN ('completed','voided')`;
  - `cost_total_cents >= 0` when present;
  - `stock_moved = true` only when `status IN ('completed','voided')`.

> The CHECK widen is the same migration that adds the snapshots, so no unreachable
> state ever exists without its posting invariants (11a D8 promised this here).

### `production_recipe_snapshots` (new, immutable — per recipe line at completion)

- `id`, `organization_id`, `production_id`;
- `recipe_id text NOT NULL`, `recipe_name text NOT NULL` (name snapshot — survives a
  later recipe trash/rename);
- `planned_qty integer NOT NULL` (same domain as `production_items.planned_qty`:
  1..100000);
- `cost_per_portion_cents integer NOT NULL`, `line_cost_cents integer NOT NULL`
  (frozen, non-negative; manager-only on read — kitchen projection omits these
  columns);
- composite FK `(org, production_id) → productions(org,id) ON DELETE cascade`;
- index `(org, production_id)`;
- no FK to live `recipes`: `recipe_id` is provenance, while `recipe_name` is the
  historical render source. A later recipe rename/trash cannot mutate the
  completed snapshot.

### `production_consumptions` (new, immutable — per ingredient at completion)

- `id`, `organization_id`, `production_id`;
- `ingredient_id text NOT NULL`, `ingredient_name text NOT NULL`, `dimension text NOT NULL`
  (snapshot; CHECK `dimension IN ('weight','volume','count')`);
- `qty_canonical numeric(12,2) NOT NULL` (the frozen requirement — kitchen-visible;
  CHECK `qty_canonical > 0`);
- `movement_id text NULL` (the F1 OUT movement posted for this ingredient; NULL when
  `stock_moved = false`, D4);
- composite FK `(org, production_id) → productions(org,id) ON DELETE cascade`;
- nullable composite FK `(org, movement_id) → inventory_movements(org,id) ON DELETE
  restrict` (MATCH SIMPLE; NULL allowed for financial-only completions);
- unique `(org, production_id, ingredient_id)` (one consumption row per ingredient);
- partial unique `(org, movement_id) WHERE movement_id IS NOT NULL` (one consumption
  row owns one posted OUT movement);
- index `(org, production_id)`;
- no FK to live `ingredients`: `ingredient_id` is provenance, while
  `ingredient_name`/`dimension` are the historical render source. Ledger-posted
  completions pin the ingredient through D6; financial-only snapshots remain readable
  even if the live ingredient is later purged.

Generate with Drizzle; do not hand-author. Review SQL/meta/FK/CHECK/index/RLS
registration and journal order before local apply. **No append-only carve-out** — the
snapshot tables are normal org-isolated data (the immutability is enforced by the data
layer never updating them, not by RLS).

---

## 4. Pure calculations — reuse, no new math

No new module. Completion BUILDS the snapshot from the existing pure functions, under
lock, inside the completing transaction:

- `explodeProduction(...)` → the aggregated requirement (must be `complete`, else
  `PRODUCTION_INCOMPLETE`);
- `componentCost(...)` → the frozen `cost_total_cents` and per-line `line_cost_cents`
  (must be `complete`; a null total is not a completed production);
- `recipeCost(...)` → per-recipe `cost_per_portion_cents` (manager snapshot column).

The snapshot is the value of these functions AT completion. Reads of a completed
production return the stored rows verbatim — they never call these functions again
(L4). A `roundCanonical`/safe-integer guard already lives in the calc modules; the
completion path additionally asserts both explosion and cost derivation are
`complete` before persisting.

---

## 5. Data layer — extend `lib/data/productions.ts`

### New mutations

- `completeProduction(db, org, id, expectedUpdatedAt)`:
  1. lock the production `FOR UPDATE`; if `status === 'completed'`, verify the
     snapshot rows exist and return `ok` with `alreadyCompleted: true` (no
     write/audit); if a completed row is missing its snapshot, throw/report an
     invariant error rather than treating it as a retry; if status is anything other
     than `planned`, return `not_completable`;
  2. enforce `expectedUpdatedAt` for the still-planned row (`stale`);
  3. lock the referenced recipe rows and the ingredient rows reached by those recipes
     `FOR UPDATE` id-asc (serialize vs. recipe/ingredient trash; extend 11a's recipe
     lock helper rather than relying on the ledger lock, because `stock_moved=false`
     would otherwise take no ingredient lock);
  4. load explosion inputs + manager costs; build the explosion and cost snapshot. If
     any recipe/consumed ingredient is missing or trashed, explosion/cost is not
     `complete`, or `planned_for IS NULL` → `incomplete` (no write);
  5. resolve `stock_moved = movesStock(planned_for, settings.stock_control_start_date)`;
  6. insert the two snapshot tables + `cost_total_cents`;
  7. if `stock_moved`: build one negative `RecordMovementInput` per consumption
     (`delta = -qty`, `source {type:'production', id, lineId:null}`, key per D5) and
     call `recordMovements` (id-asc lock, THROWS `MovementError` on
     `insufficient_stock`/`idempotency_conflict`/`not_found` → whole rollback); write
     each returned/fetched movement id back onto its `production_consumptions` row;
  8. flip status → `completed`, stamp `completed_at`, `cost_total_cents`,
     `stock_moved`;
  9. return a discriminated outcome (`ok` / `not_found` / `stale` /
     `not_completable` / `incomplete`). Do **not** catch `MovementError` inside the
     `withOrg` transaction; the action maps it after rollback (same as receipts).
- `voidProduction(db, org, id, expectedUpdatedAt)`:
  1. lock; if `status === 'voided'`, return `ok` with `alreadyVoided: true` (no
     write/audit); if status is anything other than `completed`, return `not_voidable`;
  2. enforce `expectedUpdatedAt` for the still-completed row (`stale`);
  3. load this production's posted OUT movements from `production_consumptions.movement_id`
     (or by `source_type='production' AND source_id=id` as a consistency cross-check);
     post one `reversal` per movement (`recordMovements`; positive deltas can't breach
     the floor — D7). If `stock_moved=false`, this set is empty and no movements are
     posted;
  4. flip status → `voided`, stamp `voided_at`;
  5. return `ok` / `not_found` / `stale` / `not_voidable`. Let any `MovementError`
     bubble so reversal failures roll back the status stamp.

### Loader changes (status-aware)

- `getKitchenProduction` / `getManagerProduction`: when `status ∈ {completed, voided}`,
  read the **snapshot** (consumptions + recipe snapshots) instead of deriving live.
  The DTO gains a frozen flag + `completedAt`/`voidedAt`; shortfall is omitted for a
  completed run — show frozen consumed quantities plus the `stockMoved` indicator
  instead.
- Kitchen completed-DTO selects `qty_canonical`/`ingredient_name`/`dimension` only —
  **never** the `*_cost_cents` snapshot columns (F4, key absence).
- `listKitchen/ManagerProductions`: list rows gain `completed`/`voided` status; manager
  list cost for a completed row reads `cost_total_cents` (frozen), not live.

### Trash coupling (extend, do not rewrite)

- `softDeleteProduction`: refuse when `status ∈ {completed, voided}` →
  `not_deletable` (new branch; mirrors issued-invoice/sale-protected behavior). Drafts
  and planned rows still trash as in 11a.
- `purgeIngredient` + `purgeExpired`: **add the D6 `production` movement pin** to the
  ingredient-purge candidate set (mirror `receiptPin`). This covers both manual Trash
  purge and cron purge, because `inventory_movements` cascade-delete with the
  ingredient. Manual purge refusal can reuse `INGREDIENT_IN_USE`.
- Recipe purge guard: unchanged — `countProductionsUsingRecipe` already counts all
  statuses, so a completed production keeps blocking `RECIPE_IN_PRODUCTION` via the
  11a recipe-purge invariant.

### Concurrency tests (opt-in real Postgres)

Two completions of the same planned run race → exactly one posts movements, the other
gets `stale`/no-op (no double consumption). Complete vs. concurrent recipe/ingredient
trash → either a clean completion or `incomplete`, never a half-consumed run.

---

## 6. Actions, validation, audit and errors

### Actions — `app/(app)/productions/actions.ts`

- `completeProductionAction(id, input)` — RBAC per **D1**; Zod (`productionStateSchema`
  — `expectedUpdatedAt` only); `withOrg(complete + audit in one tx)`; revalidate.
- `voidProductionAction(id, input)` — RBAC per **D2** (manager-only); same shape.
- Canonical order unchanged: RBAC → Zod → `withOrg(mutation + audit)` → revalidate.
  Catch `MovementError` **outside** `withOrg`, after rollback. A
  refused/stale/insufficient-stock/no-op operation does **not** audit; already
  completed/voided idempotent no-ops also skip audit.

### New action errors (add to `ActionErrorCode` + `actionErrors.*`)

- `PRODUCTION_NOT_COMPLETABLE` (not planned);
- `PRODUCTION_NOT_VOIDABLE` (not completed);
- `PRODUCTION_NOT_DELETABLE` (completed/voided cannot enter Trash);
- reuse `INSUFFICIENT_STOCK`, `IDEMPOTENCY_CONFLICT`, `PRODUCTION_INCOMPLETE`,
  `PRODUCTION_STALE`, `PRODUCTION_NOT_EDITABLE`.
- `MovementError` mapping: `insufficient_stock` → `INSUFFICIENT_STOCK`;
  `idempotency_conflict` → `IDEMPOTENCY_CONFLICT`; `not_found` →
  `PRODUCTION_INCOMPLETE` (the posting inputs disappeared/trashed before the ledger
  lock; rollback leaves the row planned).

### Audit (add to `AuditAction`)

- `production.complete` — metadata: item count, total planned portions, distinct
  ingredient count, `stockMoved`, movement count. **Never** cost values.
- `production.void` — metadata: reversal count. **Never** cost values.

---

## 7. UI

- **`/productions/[id]` (planned):** add a **Complete** button (visible per D1),
  disabled until the live explosion is complete + a date is set; on success the page
  re-renders as the completed view. Carries `expectedUpdatedAt`.
- **`/productions/[id]` (completed):** read-only "completed" view — frozen mise-en-place
  (consumed quantities), `completed_at`, a **Void** button (manager-only per D2), and
  for managers the frozen cost card (reads `cost_total_cents`). A clear "stock moved"
  vs. "financial-only (no stock posted)" indicator (D4).
- **`/productions/[id]` (voided):** read-only, badge `voided`, `voided_at`; no actions.
- **List + ⌘K:** add `completed`/`voided` to the status badge set; search still
  money-free. Completed/voided rows never appear in `/trash`.
- i18n: `productions.status.completed/voided`, `productions.actions.complete/void`,
  completion/void confirm dialogs, the stock-moved indicator, and the new error codes.

---

## 8. Test matrix (additions)

### Pure / snapshot integrity
- Completion freezes the snapshot: change ingredient price/stock or trash a recipe
  afterwards → the completed DTO is byte-stable; the planned-equivalent live derive
  would have changed.

### PGlite / data / RLS
- `planned → completed` posts exactly one OUT movement per ingredient, delta = −needed,
  `source_type='production'`; stock decreases by the requirement.
- `production_consumptions.movement_id` points to the exact OUT movement for each
  posted ingredient; the ledger helper returns (or the data layer fetches) movement
  ids for both inserted and deduped movement keys.
- **Idempotency:** re-running completion (same id) is a no-op / deduped — movement count
  and stock unchanged; the already-completed retry with an old `expectedUpdatedAt`
  returns ok/no-op and writes no second audit event.
- **Insufficient stock:** a requirement exceeding on-hand → `insufficient_stock`, whole
  rollback: status still `planned`, zero snapshot rows, zero movements.
- **Stock-control (D4):** `planned_for` before `stock_control_start_date` → completes,
  `stock_moved=false`, snapshot frozen, **no** movements, `movement_id=NULL`, stock
  unchanged.
- **Void:** `completed → voided` posts a reversal per OUT movement, restores stock to
  the pre-completion level; voiding twice is a no-op.
- **Void financial-only:** `stock_moved=false` production voids without reversal
  movements and stays snapshot-readable.
- Completed/voided rows refuse soft-delete, are absent from Trash, survive auto-purge.
- D6 pin: an ingredient consumed by a stock-moving completed production is blocked from
  both manual Trash purge and auto-purge.
- Stale `expectedUpdatedAt` on an eligible source state (`planned` for complete,
  `completed` for void) → rejected, zero writes/movements/audit.
- MovementError rollback: `insufficient_stock`, `idempotency_conflict` and `not_found`
  all leave zero snapshot rows/status changes and map to the planned action codes.
- DB invariant checks reject invalid status/timestamp/cost combinations; snapshot
  tables have RLS and the nullable movement FK/partial unique behave as expected.
- No live recipe/ingredient FK from snapshot tables: after a completed snapshot is
  written, later recipe rename/trash does not alter the rendered historical snapshot;
  stock-moving ingredient purge is blocked by D6, while financial-only ingredient
  purge leaves the snapshot readable from its stored name/dimension.
- Composite-FK + unfiltered `tenant_app` isolation for both snapshot tables.
- Export schema v11 contains both snapshot tables and no foreign tenant rows.

### F4 / RBAC / serialization
- Kitchen completed-DTO (SQL + serialized payload) contains no `*_cost_cents` key;
  manager completed-DTO returns the frozen cost.
- Complete/void RBAC per D1/D2 enforced **before** data access.

### Audit / concurrency
- `production.complete`/`.void` audit exactly once, in the same tx; metadata carries no
  money; refused/stale/insufficient ops do not audit.
- Real-PG opt-in: concurrent double-complete → single consumption; complete vs.
  recipe/ingredient trash → valid outcome.

---

## 9. Out of scope (11b)

- Sub-recipes / nested explosion or stockable produced output (a production does not
  create a new stockable ingredient).
- Partial completion, per-line completion, or completing more/less than planned.
- Labour/time, scheduling, calendar, kitchen tasks (11c+).
- Sales ↔ production linkage / menu popularity (Sprint 12).
- Editing a completed run (only void → new run).

---

## 10. Definition of Done

- `npm run lint && npm run typecheck && npm test && npm run build` green.
- Migration `0030` generated, SQL/meta/journal reviewed, migrate-guard green, applied
  locally only; RLS verified as `tenant_app` for both new tables; status/timestamp/cost
  CHECKs verified.
- `planned → completed → voided` proven, with idempotent OUT movements, stored
  `movement_id` links, hard `MovementError` rollback, stock-control bypass, and
  reversal-restores-stock.
- Snapshot immutability proven against later recipe/price/stock changes.
- F4 proven by separate kitchen/manager projections + serialized key absence on a
  completed run.
- Completed/voided permanence proven (no Trash, no auto-purge, recipe pin retained;
  ingredient movement pin added for both manual and cron purge).
- Export v11, audit, list/detail/⌘K, i18n wired and tested.
- No migration reaches production without separate owner review/authorization.

---

## 11. Codebase anchors

- 11a base: `lib/data/productions.ts`, `lib/calculations/production.ts`,
  `lib/calculations/componentCost.ts`, `app/(app)/productions/*`,
  `tests/productions.test.ts`, `tests/production-calc.test.ts`.
- Ledger + idempotency + batch: `lib/data/inventory.ts` (`recordMovement`,
  `recordMovements`, `buildMovementKey`, `MovementError`).
- Post/void precedent: `lib/data/receipts.ts` (`postReceipt` / `voidReceipt`).
- Stock-control: `lib/finance/stock-control.ts` (`movesStock`).
- Purge pins: `lib/data/trash.ts`, `lib/data/ingredients.ts`,
  `app/(app)/trash/actions.ts`.
- Plumbing: `lib/db/schema.ts` + `businessTables`, `lib/db/rls.ts`,
  `lib/data/account-export.ts`, `lib/data/audit.ts`, `lib/action-result.ts`,
  `drizzle/meta/_journal.json`, i18n messages.

---

## 12. Handoff to Sprint 12 / 11c

- 12 (sales) may reference a completed production for yield/sales-mix; the frozen
  consumption snapshot is the join surface.
- A future "produced ingredient" (a recipe whose output is itself stockable) would add
  an IN movement on completion — explicitly out of scope here and gated behind its own
  decision.
