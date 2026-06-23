# Sprint 12c - Inventory depth (storage areas, transfers, physical counts) - implementation plan

> **Status: IMPLEMENTED locally (2026-06-24). Full gate green (lint + typecheck +
> test + build). Migration `0033` applied LOCALLY only — awaiting SQL/`_journal.json`
> diff review before any prod migration. This is the FINAL kitchen-operations slice.**
>
> This plan was written against the current `main` code snapshot (2026-06-23,
> after Sprint 12b merged at `3377425`). The defaults below are the reviewed
> implementation contract; the **D-numbered decisions in section 2.C are owner-facing
> override switches**, not blockers if the owner accepts the defaults.
>
> Source of truth for scope: `docs/expansion-plan-kitchen-ops.md` section 6.6
> (12c) and the "review #7" reconciliation fix in section 0 of that file. Sprint
> 12c is the **last** slice of the kitchen-operations expansion track: Foundation
> F1-F6 and modules 7, 8a, 8b, 9, 10, 11a-11c, 12a, 12b are all done and on `main`.
>
> **This plan ships migration `0033` (3 new tables + 1 nullable column on
> `inventory_movements`).** Per the house rule used since F5/F6, `0033` is applied
> **LOCALLY only** until the full SQL/meta diff is reviewed; it must not reach prod
> without explicit authorization.

## 0. Outcome and boundaries

Sprint 12c adds physical-location depth to the existing authoritative stock
ledger without weakening any F1 guarantee:

- **Storage areas** - named physical locations (walk-in, dry store, bar...) so a
  manager/chef can see *where* stock sits, not just the org total.
- **Transfers** - move quantity of an ingredient from one area to another as a
  balanced pair of F1 movements that nets zero at the ingredient level.
- **Physical counts** - count what is actually on the shelf in an area and commit
  the difference as F1 `adjustment` movements, so the ledger matches reality.

The non-negotiable property the third review demanded (`expansion-plan` section 0,
review #7) is the **balance invariant**:

```
ingredients.stock_quantity  ==  Σ delta_canonical of ALL movements (every area, incl. the default/NULL bucket)
per-area balance(area)       =  Σ delta_canonical of movements in that area
Σ per-area balances          =  ingredients.stock_quantity        (they reconcile by construction)
```

Because `inventory_movements` is **append-only at the DB** (`lib/db/rls.ts`,
SELECT+INSERT only) and `ingredients.stock_quantity` is just the running sum of
deltas, the invariant holds automatically as long as **every area-affecting change
is a movement** - transfers and count adjustments are inserts, never edits. 12c
adds no new way to mutate stock outside `recordMovement`.

What 12c is **not**:

- Not lot / batch / use-by / expiry tracking (see **D1** - the section heading in
  the expansion plan says "use-by" but the 12c body never specifies it; proposed
  deferred to backlog).
- Not a multi-warehouse transfer-order workflow (transfers are immediate, not
  draft documents).
- Not a change to how sales (12a) or productions (11b) consume stock - their OUT
  movements stay area-agnostic in v1 (see **D4**).

Hard invariants carried from Foundation:

- **Org isolation:** every read/write scoped by server-derived `organizationId`,
  inside `withOrg`; client never sends `organization_id`.
- **F1 idempotency:** transfers and count commits post movements through
  `recordMovement` / `recordMovements` with deterministic `idempotencyKey`s, so a
  double-submit or server retry applies them exactly once.
- **Throw to roll back:** `runInOrg` commits on normal return, rolls back only on
  throw. Multi-movement operations (a transfer = 2 movements; a count commit = N
  movements) go through `recordMovements`, which throws `MovementError` mid-batch
  so the whole `withOrg` rolls back - no partial transfer, no partial count.
- **Append-only ledger:** corrections are equal-and-opposite inserts, never edits.
- **RBAC (F4):** inventory quantities + storage are kitchen-visible; **stock value
  / money stays manager-only**. See **D5** for the per-action matrix.

## 1. Points most likely to break or be unsafe (bake these in)

1. **`recordMovement`'s stock floor is the ORG TOTAL, not per-area.** Today
   (`lib/data/inventory.ts:168`) the insufficient-stock check is
   `stock_quantity + delta < 0`. A transfer of 5 kg out of the bar when the bar
   holds 2 kg but the org holds 100 kg would pass that check and produce a
   **negative per-area balance**. 12c MUST add a **per-area floor** check in the
   transfer/count data layer, computed **after** the F1 `FOR UPDATE` ingredient
   lock is held, before posting the OUT leg. `recordMovement` keeps its total
   floor unchanged; the per-area floor lives in the caller (same pattern as sales/
   production computing requirements before calling `recordMovements`).

   **Transfer nuance:** because the current primitive checks the org-total floor on
   each row, a zero-sum transfer must post the **IN leg before the OUT leg** inside
   the same `withOrg` transaction. Otherwise a named area with positive stock can be
   impossible to move out of when the default/NULL bucket is negative from earlier
   area-agnostic sales/production consumption. The source-area floor remains the real
   transfer guard; throw-to-rollback still prevents partial transfers.

2. **Concurrency is serialized by the ingredient lock, and only by that.** Two
   concurrent transfers out of the same area on the same ingredient are made safe
   by the existing per-ingredient `FOR UPDATE` (held to tx end), NOT by anything
   area-specific. The per-area balance therefore must be read **inside the same tx,
   after** the lock - never cached from preview. A real-PG concurrency + deadlock
   test is required (deterministic id-asc lock order via `recordMovements`).

3. **`storage_area_id` must enter the F1 immutable-payload revalidation.** Add the
   column to `RecordMovementInput`, the INSERT, and the idempotency comparison in
   `lib/data/inventory.ts`. Tighten the existing-key pre-check to validate the FULL
   immutable payload (`source_line_id`, `reversal_of`, and `storage_area_id`), not
   only `sameCore`; otherwise a same-key/different-area row could be treated as
   `deduped`. (In practice the transfer/count keys include the source id + leg +
   ingredient, so collisions are improbable - but the defensive comparison must be
   correct by construction.)

4. **The default area owns the legacy `NULL` bucket; do not break legacy rows.**
   Every existing movement has `storage_area_id IS NULL`. The backfill leaves them
   NULL, and the default-area balance counts `storage_area_id = <defaultId> OR IS
   NULL`. This is the whole reason area is *optional* on movements (review #7):
   sales/production keep posting NULL and still reconcile. Because changing which
   row is `is_default` would reassign every NULL movement to a different area
   **without a ledger movement**, the default area is immutable in v1: managers may
   rename it, but not set a different default.

5. **Counts must compute the adjustment against the LIVE ledger at commit, under
   lock - not against a number snapshotted at count-entry time.** Otherwise a sale
   that fires between count entry and commit gets double-applied. Store the counted
   value and the system value on the count item for the record, but compute
   `delta = counted - liveAreaBalance` at commit. The count-vs-physical timing gap
   is an accepted v1 limitation (counted value wins at commit), mirrored on the F5
   bank-double-count limitation pattern.

6. **`inventory_movements` source types already exist.** `MovementSourceType`
   (`lib/data/inventory.ts:13`) already includes `'transfer'`, `'stock_count'`, and
   `'adjustment'`. No new source-type values are needed; 12c just *uses* them.
   (Proposed: transfers use `source_type='transfer'`; count adjustments use
   `source_type='adjustment'` with `source_id = <stock_count id>`.)

## 2. Decisions

### 2.A Locked (no migration risk, no owner call needed)

1. **Reuse F1.** Transfers and count adjustments post through the existing
   `recordMovement` / `recordMovements`; no new ledger primitive.
2. **Append-only stays.** No UPDATE/DELETE of any movement. Corrections to a
   committed count are a *new* count (D7), not an edit.
3. **No new money.** Storage areas, transfers, and counts carry **zero monetary
   fields**. Stock value remains a manager-only derived view of existing
   `price_cents` × balance, unchanged.
4. **Three new tables, standard org_isolation RLS** (NOT append-only - areas get
   renamed, counts have a draft phase): `storage_areas`, `stock_counts`,
   `stock_count_items`. `inventory_movements` keeps its append-only RLS; only a
   nullable column is added to it.

### 2.B Defaults (proposed; will code as written unless overridden)

- **Per-area balance query:** `SUM(delta_canonical) GROUP BY ingredient_id` over
  `inventory_movements` filtered by `(organization_id, storage_area_id)` (with the
  immutable default bucket matching `= defaultId OR IS NULL`). New index
  `(organization_id, storage_area_id, ingredient_id)`.
- **Transfer = two F1 movements in one `withOrg`:** `source_type='transfer'`,
  `source_id=<client transfer uuid>`; IN leg (`+qty`, area B, `lineId='in'`) is sent
  before OUT leg (`-qty`, area A, `lineId='out'`) to avoid the current F1 per-row
  org-floor false negative on zero-sum transfers. Both are posted via
  `recordMovements` in one transaction (id-asc lock - here the same ingredient, so
  one lock). Idempotency keys:
  `transfer:<transferId>:out:<ingredientId>` and `:in:`. Nets zero at ingredient
  level, so `stock_quantity` is unchanged; only the area split moves.
- **Count commit:** for each counted ingredient, post one `adjustment` movement
  `delta = counted - liveAreaBalance` (skip zero-delta lines - no movement), key
  `adjustment:<countId>:<countItemId>:<ingredientId>`, `source_line_id=countItemId`,
  `storage_area_id = count.area`. All via `recordMovements` (throw-to-rollback). The
  count item records
  `counted_canonical`, the `system_canonical` snapshot read at commit, and the
  resulting `movement_id` (NULL when delta was zero). After posting, query the
  movements back by idempotency key/source id to fill `movement_id` (same pattern as
  production 11b).
- **Pure calc module** `lib/calculations/inventory-areas.ts`: `countAdjustment(counted,
  system) -> delta` and `reconcileAreaTotals(perArea[]) -> total`, with tests for
  zero / negative / large / rounding (`numeric(12,2)`), matching the CLAUDE rule
  that stock math lives in `lib/calculations/` with edge tests.
- **Validation** `lib/validation/inventory-areas.ts` (Zod): area name (1..80, trimmed,
  formula-neutralized on any later export), transfer (areaFrom ≠ areaTo, qty
  `> 0` within `numeric(12,2)` max; compare after resolving NULL/default aliases),
  count (area + line list, counted `>= 0`).
- **Manual stock movement UI** gains an **optional area selector**. If the manager
  selects a real area (including "Main"), write that `storage_area_id`; if the legacy
  manual-adjustment action is called with no area, write NULL and let it reconcile into
  the default bucket. No change to its idempotency contract.

### 2.C Owner override switches (defaults already reviewed)

- **D1 - Use-by / lot / expiry scope.** The expansion-plan sequencing line reads
  "Inventory depth (storage/**use-by**/counts)", but the 12c body (section 6.6)
  specifies only areas, transfers, and counts - no lot or expiry model. Lot/expiry
  is a materially larger lift (per-lot ledger, FEFO consumption, expiry alerts) and
  the F1 ledger has no lot concept today. **Proposed default: defer lot/use-by to a
  dedicated backlog sprint; 12c ships areas + transfers + counts only.** Confirm or
  pull it back in.

- **D2 - Default-area representation.** Two viable shapes:
  - **(Recommended) Seed a real "Main" default `storage_areas` row per org**
    (`is_default=true`, partial-unique one-default-per-org), AND treat legacy
    `storage_area_id IS NULL` movements as belonging to it (default balance =
    `= defaultId OR IS NULL`). Matches the expansion plan's "seed one 'Main' default
    per org" wording; the UI always has a concrete default to show and transfer
    into. The default can be renamed but **not replaced** in v1, because replacing it
    would move the NULL bucket between areas without a ledger movement. Requires a
    tiny per-org backfill in `0033` (safe: the migration runs before `rlsStatements`
    re-enable, so the INSERTs aren't blocked by FORCE RLS).
  - **(Simpler) No default row at all - the `NULL` bucket *is* the default**,
    surfaced in the UI as "Main (default)" via i18n. Zero backfill, but "transfer
    into default" writes `NULL` and the concept of a default is implicit.

  Proposed default: **(Recommended) seeded immutable default row + NULL-as-default
  reconciliation.**

- **D3 - Per-area OUT floor placement.** Proposed: enforce the per-area floor in
  the transfer/count data layer (under the F1 lock), keep `recordMovement`'s total
  floor as-is, and add `storageAreaId` to `RecordMovementInput` +
  full idempotency-payload comparison. Transfers post IN first then OUT to avoid a
  false org-total floor failure on a net-zero batch. Alternative: push a per-area
  floor or batch-net floor *into* `recordMovement` itself. Proposed default keeps the
  primitive's contract minimal and matches how sales/production already pre-compute.
  Confirm.

- **D4 - Do sales/production consume from a specific area?** Proposed default:
  **no** - 12a/11b OUT movements stay area-agnostic (`storage_area_id NULL` =
  default bucket), so 12c does **not** touch the sales/production callers. This is
  the review #7 "area optional in v1" stance. If the owner wants consumption to
  draw from a chosen area, that's extra scope in 12a/11b and should be its own
  decision.

- **D5 - RBAC matrix (server-enforced, per F4).** Proposed:

  | Action | Kitchen | Manager |
  |---|---|---|
  | View areas + per-area balances + counts | ✅ | ✅ |
  | View per-area **stock value** (money) | ❌ | ✅ |
  | Create / rename / delete area | ❌ | ✅ |
  | Start + commit a physical count | ✅ | ✅ |
  | Transfer stock between areas | ✅ | ✅ |

  Rationale: counting and transferring are operational (the chef does them, money-
  free); area structure is org config (manager). All money stays manager-only.
  Confirm the area-CRUD-is-manager-only call. The default area can be renamed by a
  manager but not replaced in v1 (D2).

- **D6 - Entitlement gate.** Proposed: **none** - inventory is a base module
  (Starter, modules 1-3), and inventory depth ships to all plans like the rest of
  inventory. (Contrast 12a/12b sales = Pro+ `invoices`.) Confirm no `requireFeature`.

- **D7 - Count lifecycle.** Proposed: `draft` (editable line entries) ->
  `committed` (posts adjustments, immutable thereafter). **No void in v1** - a
  correction is a new count. Committed counts are historical records (like
  `production_consumptions`). Confirm.

- **D8 - Area delete semantics.** Areas FK from immutable movements, so a hard
  delete would orphan history. Proposed: **soft-delete** (`deleted_at`) with guards
  - cannot delete the immutable default area, cannot delete an area with any non-zero
  per-area balance (must transfer/count it to zero first), and cannot delete an area
  referenced by a draft count; the composite FK is `ON DELETE RESTRICT` as a DB
  backstop. Committed counts may keep referencing a soft-deleted area for history.
  Confirm.

- **D9 - Migration discipline.** `0033` is **local-only** until the SQL/meta diff
  is reviewed; account-export bumps **13 -> 14**. (Standard since F5/F6.)

## 3. Flow

```text
Storage areas (manager):
  create / rename / soft-delete  -> CRUD action, audited
  default area is seeded + immutable in v1 (rename only)

Transfer (kitchen or manager):
  pick ingredient, areaFrom, areaTo, qty, clientTransferId
    -> withOrg:
         lock ingredient (F1 FOR UPDATE)
         read per-area balance(areaFrom); reject if qty > balance  (per-area floor)
         recordMovements([ IN(+qty, areaB), OUT(-qty, areaFrom) ])  (IN first; throw -> rollback)
         writeAuditEvent inventory.transfer (counts/ids only)

Physical count (kitchen or manager):
  start count for an area  -> stock_counts(status='draft')
  enter counted_canonical per ingredient -> stock_count_items
  commit:
    -> withOrg:
         lock stock_count row; reject stale expectedUpdatedAt if still draft
         lock each counted ingredient (id-asc)
         for each line: system = liveAreaBalance; delta = counted - system
                        if delta != 0: queue adjustment movement (area, lineId=countItemId)
         recordMovements(all non-zero adjustments)  (throw -> rollback)
         query posted movement ids by idempotency key/source id
                        record system_canonical + movement_id on the item
         flip stock_counts -> 'committed'
         writeAuditEvent inventory.countCommit (lineCount, movementCount; no qty)
```

A second commit of an already-committed count is a no-op (status guard +
F1 idempotency keys as backstop). A transfer/count that fails any per-area floor or
F1 check throws and rolls back wholesale.

## 4. Schema (migration 0033)

`storage_areas`:

```
id, organization_id,
name text NOT NULL,
is_default boolean NOT NULL DEFAULT false,       -- immutable after seed in v1
sort_order integer NOT NULL DEFAULT 0,
deleted_at timestamptz NULL,
created_at, updated_at
-- unique (organization_id, id)                         [self-FK target]
-- unique partial (organization_id, lower(name)) WHERE deleted_at IS NULL
-- unique partial (organization_id) WHERE is_default AND deleted_at IS NULL  [one default/org]
-- check trimmed name 1..80; sort_order >= 0
```

`stock_counts`:

```
id, organization_id,
storage_area_id text NULL,        -- recommended UI writes defaultId; NULL accepted as default alias
status text NOT NULL DEFAULT 'draft',   -- draft | committed
note text NULL,
created_by text NULL,             -- actor user id (provenance)
committed_at timestamptz NULL,
created_at, updated_at
-- unique (organization_id, id)
-- check status in ('draft','committed')
-- composite FK (organization_id, storage_area_id) -> storage_areas(organization_id, id) ON DELETE RESTRICT
```

`stock_count_items`:

```
id, organization_id,
stock_count_id text NOT NULL,
ingredient_id text NOT NULL,      -- provenance only (no live FK; mirrors production_consumptions)
counted_canonical numeric(12,2) NOT NULL,     -- counted >= 0
system_canonical  numeric(12,2) NULL,         -- live area balance snapshot at commit
movement_id text NULL,            -- provenance id of the F1 adjustment (NULL when delta was 0)
created_at, updated_at
-- unique (organization_id, stock_count_id, ingredient_id)
-- check counted_canonical >= 0
-- composite FK (organization_id, stock_count_id) -> stock_counts(organization_id, id) ON DELETE CASCADE
-- index (organization_id, movement_id)
-- NO live FK to inventory_movements: ingredient purge cascades movements, while count items remain provenance history
```

`inventory_movements` (column add only - append-only RLS untouched):

```
ADD COLUMN storage_area_id text NULL
-- composite FK (organization_id, storage_area_id) -> storage_areas(organization_id, id) ON DELETE RESTRICT  (MATCH SIMPLE skips NULL)
-- index (organization_id, storage_area_id, ingredient_id)
```

`RecordMovementInput` (`lib/data/inventory.ts`) gains optional
`storageAreaId?: string | null`; threaded into the INSERT and into **both**
idempotency comparisons (existing-key pre-check and post-conflict revalidation).
Default it to `null` for every existing caller (sales/production/seed unchanged →
NULL bucket). Manual stock movement passes an area id only when the user explicitly
selects an area.

### Migration staging (0033 - hand-verify, single migration is fine here)

1. `CREATE TABLE storage_areas`, `stock_counts`, `stock_count_items`.
2. `ALTER TABLE inventory_movements ADD COLUMN storage_area_id text` (nullable -
   no backfill of movements; legacy rows stay NULL = default).
3. Add the composite FKs + the new index.
4. **(D2 recommended only)** backfill one `is_default` "Main" area per existing org
   (`INSERT ... SELECT DISTINCT organization_id FROM organization_settings`). Safe
   because the migration runs **before** `scripts/migrate.ts` re-applies
   `rlsStatements`, so FORCE RLS is not yet active on the new table. Do **not**
   update historical `inventory_movements`; NULL remains the legacy default bucket.
5. Add the three tables to `businessTables` (`lib/db/schema.ts`) → `rlsStatements`
   auto-applies standard `org_isolation` to each. `inventory_movements` stays in
   `APPEND_ONLY_TABLES`.
6. **Verify `_journal.json` `when` > 1782232430118** (current max, `0032`). The
   `migrate-guard` aborts if not (the recurring silent-skip gotcha).

## 5. Data layer

`lib/data/storage-areas.ts`: `listAreas`, `ensureDefaultArea` (idempotent),
`createArea`, `renameArea`, `softDeleteArea` (guards: not default, zero balance,
no draft count). No `setDefaultArea` in v1; the seeded default row is immutable
apart from rename.

`lib/data/inventory-areas.ts`:
- `areaBalances(tx, org, areaId | DEFAULT)` -> `Map<ingredientId, canonical>`
  (the `SUM ... GROUP BY` with the `= defaultId OR IS NULL` rule for default).
- `resolveAreaForWrite(tx, org, areaId | null)` validates active areas. For
  area-aware writes, pass the concrete default id when the UI selected "Main"; accept
  null only as the legacy/default alias for existing callers or old clients.
- `transferStock(tx, org, actor, {ingredientId, areaFrom, areaTo, qty})`: lock →
  per-area floor on `areaFrom` → `recordMovements([in,out])` (IN first to avoid a
  transient org-total floor failure on a net-zero transfer) → returns updated
  balances. Requires a caller-supplied `clientTransferId` UUID for deterministic
  replay. Throws typed error mapped to stable code on floor/F1 failure.
- `commitStockCount(tx, org, actor, countId)`: load draft + items, lock ingredients
  id-asc, reject if any counted ingredient is missing/trashed, compute
  `delta = counted - liveAreaBalance` per line, post non-zero `adjustment` movements
  via `recordMovements` (`source.lineId=countItemId`), query the posted movements by
  idempotency key/source id, write `system_canonical`+`movement_id` back onto items,
  flip status to `committed`. Idempotent (status guard + F1 keys).

New/confirmed `ActionErrorCode`s: reuse `INSUFFICIENT_STOCK`,
`IDEMPOTENCY_CONFLICT`, `NOT_FOUND`, `FORBIDDEN`, `DUPLICATE_NAME`,
`INVALID_INPUT`, `INVALID_STATUS_TRANSITION`; add `INVENTORY_AREA_STALE`,
`STOCK_COUNT_STALE`, `DEFAULT_AREA_LOCKED`, `AREA_NOT_EMPTY`, and
`AREA_HAS_DRAFT_COUNT` (clearer than generic codes for the area/count guards).

## 6. Actions, RBAC, audit

`app/(app)/inventory/area-actions.ts` (manager-only area CRUD) and transfer/count
actions (kitchen-or-manager per D5). Mandatory order, matching every prior sprint:

```text
role gate:
  - isManager() for area CRUD + stock-value views
  - require kitchen OR manager for transfers/counts
  -> rate limit (existing inventory bucket, or a new `inventory` bucket if absent)
  -> Zod validation
  -> optimistic expectedUpdatedAt where there is a mutable row (areas/count drafts)
  -> withOrg  (lock -> floor/compute -> recordMovements)
  -> writeAuditEvent  (counts/ids only - NEVER quantities, NEVER value)
  -> revalidatePath
```

Audit actions (counts/ids only, no qty, no money): `inventory.areaCreate`,
`inventory.areaRename`, `inventory.areaDelete`,
`inventory.transfer` (`{ transferId, ingredientId, areaFrom, areaTo }` - no qty),
`inventory.countCommit` (`{ areaId, lineCount, movementCount }`).

Revalidate `/inventory` (+ any per-area view) after every mutation.

## 7. UI (next-intl, mobile ~380px, keyboard)

- `/inventory`: add an **area filter** (All / each area / default) showing per-area
  balances; **stock value column manager-only** (server-projected, omitted by key
  absence for kitchen, per F4 - same technique as the recipe/production cost
  projections).
- **Transfer** dialog: ingredient, from-area, to-area, qty; client-side
  `areaFrom != areaTo`; surfaces `INSUFFICIENT_STOCK` against the *source area*.
- **Count** flow: start a count for an area, enter counted canonical per ingredient
  (pre-filled with current system balance as a hint, editable), commit; show the
  computed deltas before commit; committed counts are read-only history.
- **Areas** settings (manager): list, create, rename, soft-delete (with the
  not-default / not-empty / draft-count guards surfaced as friendly messages). The
  default area can be renamed but not replaced in v1.
- i18n under `inventory.areas.*`, `inventory.transfer.*`, `inventory.counts.*`;
  empty/loading/error states; the default area labelled via i18n, never hardcoded.
- ⌘K: storage areas are minor config - **not** added to global search in v1 (flag
  if the owner wants it).

## 8. Cross-cutting wiring (DoD additions from expansion-plan section 3)

- **GDPR account export** (`lib/data/account-export.ts`): add `storageAreas`,
  `stockCounts`, `stockCountItems` to the bundle; `inventory_movements` rows now
  carry `storage_area_id` (flows through `select()`). Bump
  `ACCOUNT_EXPORT_SCHEMA_VERSION` **13 -> 14** with a `// v14 (Sprint 12c)` note.
- **Seed / demo** (`scripts/seed-demo.ts`): create the default area per seeded org;
  optionally seed a second area + one transfer + one committed count for demo
  realism (movements already pass `source:{type:'seed'}`).
- **Onboarding / `organization.created` webhook:** call `ensureDefaultArea`
  alongside the existing org-defaults seed (so new orgs always have "Main").
- **Trash / purge:** areas are operational config, not on the 30-day Trash timer;
  committed counts are permanent history. Purging an ingredient still cascade-
  deletes its movements (the FK is a referential action, exempt from append-only
  RLS) - a test asserts an ingredient purge does not strand count items. Count
  items hold provenance `ingredient_id` + nullable `movement_id` **without live FKs**
  to either row, so historical count records survive catalogue cleanup.
- **Observability:** transfers/count-commits flow through `unexpected()`/`logError`
  on the unexpected path like every other action.

## 9. Tests

**Pure calc** (`lib/calculations/inventory-areas.test.ts`): `countAdjustment` zero /
positive / negative / large / `numeric(12,2)` rounding; `reconcileAreaTotals` sums
to the ledger total.

**Data layer (PGlite)** (`tests/inventory-areas.test.ts`):
- Balance invariant: after a transfer, `stock_quantity` unchanged, `balance(A)`
  down by qty, `balance(B)` up by qty, `Σ areas == stock_quantity`.
- Transfer ordering: when the default/NULL bucket is negative but the source area has
  enough stock, an IN-first zero-sum transfer into default succeeds and restores the
  default balance; an OUT-first implementation would fail the org-total floor.
- Per-area floor: transfer exceeding the source-area balance (but under org total)
  → `INSUFFICIENT_STOCK`, zero movements written.
- Default bucket: legacy NULL movements count toward the default area balance;
  org-total reconciles with NULL + named areas.
- Count commit: positive and negative deltas post the right `adjustment`
  movements; zero-delta lines post no movement; `system_canonical`/`movement_id`
  recorded; `stock_quantity` ends equal to counted for that area's ingredients.
- Count timing: a movement between count-entry and commit → adjustment computed
  against the **live** balance at commit (documents the accepted v1 behavior).
- Count commit with a missing/trashed counted ingredient rejects before writing
  movements; draft count remains draft.
- All-or-nothing: a count whose 2nd line oversells (mid-batch `MovementError`) →
  zero movements, count stays `draft`.
- Idempotency: re-commit a committed count → no-op, no duplicate movements; replay
  a transfer with the same `clientTransferId` → deduped; same idempotency key with a
  different `storage_area_id` → `IDEMPOTENCY_CONFLICT`.
- Append-only: manual UPDATE/DELETE of an area movement blocked by RLS; ingredient
  cascade-purge still removes movements and leaves count items (provenance) intact.
- Area delete guards: default area → refused; non-empty area → `AREA_NOT_EMPTY`;
  area referenced by a draft count → `AREA_HAS_DRAFT_COUNT`; emptied/no-draft area →
  soft-deletes. Default replacement is not exposed/accepted in v1.
- Org isolation (4-way RLS): SELECT isolation, INSERT `WITH CHECK`, UPDATE retag,
  DELETE reachability for `storage_areas` / `stock_counts` / `stock_count_items`.

**Real-PG concurrency** (`tests/concurrency/inventory-areas.pg.test.ts`,
`describe.skipIf(!TEST_DATABASE_URL)`, mirrors `recipe-line.pg.test.ts`): two
concurrent transfers out of the same area on the same ingredient → serialized by
the F1 lock; combined out-qty exceeding the area balance → exactly one succeeds, the
other gets `INSUFFICIENT_STOCK`; deadlock probe with a shared ingredient.

**Actions / RBAC** (`tests/inventory-areas-actions.test.ts`):
- Kitchen can transfer + commit a count; kitchen **cannot** create/delete an area
  (`FORBIDDEN` before data) and gets no stock-value field.
- Manager full access.
- Stale `expectedUpdatedAt` on area rename/delete and count draft/commit returns the
  stable stale code before side effects.
- Audit metadata carries ids/counts only - **no quantities, no money** (asserted).

## 10. Out of scope

- Lot / batch / use-by / expiry tracking and FEFO consumption (D1 → backlog).
- Draft transfer *orders* / multi-step transfer approval.
- Per-area consumption selection for sales/production (D4 → future).
- Negative-count "shrinkage" reporting/analytics beyond the raw adjustment movement.
- Count void/reopen (D7 - correction is a new count in v1).
- ⌘K search for areas.

## 11. Definition of Done

- `npm run lint && npm run typecheck && npm test && npm run build` green.
- Migration `0033` applied **locally only**; SQL + `_journal.json` diff handed to
  the senior dev before any prod migration; `migrate-guard` confirms ordering.
- Balance invariant proven by test for transfers and counts (org total == Σ areas
  == Σ all movements).
- Per-area floor, IN-first zero-sum transfers, all-or-nothing rollback, idempotent
  replay (including storage-area conflicts), append-only, stale guards, and area-delete
  guards all tested.
- 4-way RLS + RBAC (kitchen no money / no area-CRUD) + real-PG concurrency tests
  green.
- Account export bumped 13 → 14 with the three new tables + the movement column.
- Immutable default area seeded for new orgs (onboarding + webhook) and backfilled for
  existing orgs (D2); historical movement rows remain NULL and reconcile into that
  default bucket; seed/demo updated.
- i18n, empty/loading/error/forbidden states wired; mobile + keyboard checked.
- `docs/expansion-plan-kitchen-ops.md` section 8 table marked 12c DONE; this is the
  **final** kitchen-ops sprint - note Foundation + all modules complete.

## 12. Owner confirmations before coding

Defaults above are approved by this review; these are the owner-facing switches to
override deliberately, not blockers if the owner accepts the defaults.

1. **D1** - defer use-by/lot/expiry to backlog; 12c = areas + transfers + counts.
2. **D2** - seeded immutable "Main" default row per org + NULL-as-default
   reconciliation (recommended), vs NULL-bucket-only.
3. **D3** - per-area floor in the data layer; `recordMovement` total floor unchanged;
   transfers post IN first then OUT.
4. **D4** - sales/production consumption stays area-agnostic (NULL/default) in v1.
5. **D5** - RBAC: transfers + counts kitchen-allowed; area CRUD + stock value
   manager-only; default can be renamed but not replaced.
6. **D6** - no entitlement gate (all plans).
7. **D7** - counts draft → committed, no void in v1.
8. **D8** - area soft-delete with not-default / not-empty guards.
9. **D9** - `0033` local-only until diff review; account export 13 → 14.
