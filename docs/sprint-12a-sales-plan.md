# Sprint 12a — Sales (daily close): post revenue + consume stock — implementation plan

> **Status: SENIOR-REVIEWED implementation plan — NOT started. The defaults in §1.B
> are the implementation contract unless the owner explicitly overrides one before
> coding. One EXTERNAL gate (accountant sign-off, §0/§10) blocks *shipping* 12a but
> not building/reviewing it.**
> Source of truth for scope: `docs/expansion-plan-kitchen-ops.md` §2.4, §4 F5, §6.6
> (12a) and the F5 contract `docs/sales-transaction-contract.md`. This plan refines
> the *how*; it does not expand scope. It reuses the F5 primitives already shipped
> (`postSaleTransaction`/`voidSaleTransaction`, `lib/calculations/tax.ts`,
> `lib/finance/stock-control.ts`, the protected-transaction enforcement, the
> `daily_sales` system category, `transactions.source_type/source_id` + its partial
> unique + CHECK), the F1 inventory ledger (`recordMovements`/`buildMovementKey`/
> `MovementError`), the production explosion (`lib/calculations/production.ts`), and
> the shipped patterns: optimistic concurrency (`expectedUpdatedAt` + `FOR UPDATE`),
> audit log, Zod, stable `ActionErrorCode` + next-intl, ⌘K search, entitlements.
> Migration `0032` is **LOCAL only** until its generated SQL/meta diff is reviewed
> and the owner explicitly authorizes production.

## 0. Outcome and non-negotiable boundaries

Sprint 12a ships **daily-close Sales**: a manager records a day's sales as line
items (a recipe / menu / ingredient sold at `units × net unit price`, with tax; a
direct ingredient line also states the canonical stock amount consumed per sold
unit), then **posts** the close. Posting projects the sale into **one protected `income`
transaction** (gross total, via the F5 primitive) **and** writes **idempotent OUT
stock movements** consuming the ingredients behind the sold items — but only when the
sale date is on/after the org's `stock_control_start_date` (financial-only mode).
**Voiding** a posted close soft-deletes that income row (the controlled F5 path) and
reverses the stock movements (F1), atomically and idempotently. Sales are
**financial → manager-only** (F4: kitchen has no access).

This is **not** a per-ticket POS and **not** a bank-reconciliation tool. Refunds,
multi-rate tax, and storage-area depth are out of scope (§9).

Hard invariants (carried from the project rules + F5):

- **Multi-tenancy (RULE #1):** every row carries `organization_id`; every query is
  org-scoped; both tables are in `businessTables` → standard `org_isolation` RLS; all
  writes run inside `withOrg`. `organization_id` is never accepted from the client.
- **Single revenue source:** a posted sale's income row is created **only** by
  `postSaleTransaction` (the invariants — `type='income'`, `amount = gross`,
  `recipe_id = NULL`, `source_type='sale'`, `daily_sales` category — are fixed in the
  primitive; the caller cannot bend them). Dedup **with conflict detection** (F5):
  re-posting the same sale id with the same gross+date is a `deduped` no-op; a
  different payload is `IDEMPOTENCY_CONFLICT`, never an overwrite.
- **Exclusive tax, per-line-then-sum:** money is integer cents; each line stores
  `net/tax/gross` separately; the sale total is the **sum of the rounded line
  figures** (no re-round) via `lib/calculations/tax.ts`. A configured org rate is
  **required** before posting — **no silent 0%** (F5).
- **Stock consumption is idempotent + stock-control-aware:** OUT movements go through
  F1 (`recordMovements`, deterministic aggregated keys:
  `buildMovementKey('sale', saleId, null, ingredientId)` →
  `sale:<saleId>:agg:<ingredientId>`). They are posted **only** when
  `movesStock(saleDate, startDate)` is true. An
  insufficient stock-out makes `recordMovements` THROW (L3) → the whole post rolls
  back. Changing the start date later never retro-recalculates posted movements.
- **Void retention contract (6 points, F5):** points 3/4/6 are already enforced at the
  transaction layer; 12a completes points **1, 2, 5** — the sale status flip + income
  soft-delete + F1 reversals + audit commit in **one `withOrg`** (throw-to-rollback),
  the voided sale row is retained indefinitely, and a second void never double-reverses.
- **Protected transaction:** the sale-sourced income row is owned solely by the sale
  lifecycle (F5: the generic transaction mutators + trash actions refuse it, Trash
  excludes it, auto-purge skips it). 12a adds **nothing** to that — it only calls the
  primitives.

---

## 1. Decisions

### 1.A — Locked (from the spec / F5, restated for context)

1. **L1 — Two tables.** `sales` + `sale_items` with a composite `(organization_id,
   sale_id)` FK (cascade). A line always belongs to exactly one sale.
2. **L2 — Manager-only (F4).** Every page, Server Action and document route checks the
   manager role **before** data access. Kitchen never sees sales.
3. **L3 — Daily close, reference = the close date.** A sale is a per-day total; its
   reference is `sale_date`. The posted income transaction's `occurred_on = sale_date`.
4. **L4 — Single revenue source.** Posting calls `postSaleTransaction` (F5) — never a
   caller-built income row. Dedup + conflict detection per the F5 contract.
5. **L5 — Exclusive tax via `tax.ts`.** `saleTotals`/`saleLineTotals`/`lineTax`
   (already shipped + tested) compute the frozen net/tax/gross. No new tax math.
6. **L6 — Void = controlled soft-delete + F1 reversal, atomic + idempotent.** Uses
   `voidSaleTransaction` (F5) + `recordMovements` reversals in one `withOrg`.
7. **L7 — Financial-only mode.** `movesStock` (F5) decides at posting time whether OUT
   movements are written; the decision is frozen on the sale (`stock_moved`).
8. **L8 — Protected transaction already enforced (F5).** 12a does not re-implement the
   guards; it relies on them and adds the sale-status guards (points 1/2/5/6 of L6).

### 1.B — Defaults confirmed by this review (owner can override before coding)

> Each has a recommended default so a "no changes" review is a valid approval.

- **D1 — Sale-line item model.** A line sells a real catalogue item.
  - **Recommended: a discriminated `item_kind` (`recipe | menu | ingredient`) + a
    nullable composite `ON DELETE restrict` FK per kind + a FROZEN `item_name`
    snapshot** (so a later rename/trash never rewrites a posted close). Exactly one ref
    is set, matching `item_kind` (DB CHECK). `quantity` = units sold (integer ≥ 1),
    `unit_net_cents` = net price per sold unit, `tax_rate_bps` per line. For
    `item_kind='ingredient'`, also require `ingredient_qty_canonical` = canonical stock
    quantity consumed **per sold unit** (numeric > 0; default 1 only for count-based
    items). This avoids pretending an integer sale count can represent grams/ml.
  - Alternative: also allow a free-text/no-ref line that books revenue but moves no
    stock. *Pick one — this drives the CHECK + the consumption explosion.*
- **D2 — Stock consumption on post (the big one).** Posting consumes the ingredients
  behind the sold items.
  - **Recommended: recipe/menu lines EXPLODE to ingredients (reuse
    `explodeProduction` for recipes + a menu→recipe expansion), ingredient lines
    consume `quantity × ingredient_qty_canonical`; aggregate the needed canonical
    quantity per ingredient across all lines, then post ONE OUT movement per ingredient
    via `recordMovements` (F1) when `movesStock` is true.** The movement source is
    document-level aggregated (`source_line_id=NULL`), with idempotency key
    `sale:<saleId>:agg:<ingredientId>`. A line whose source item or recipe/menu
    component is trashed/missing → `SALE_INCOMPLETE` (no post), mirroring production
    completion. Insufficient stock → `MovementError` → `INSUFFICIENT_STOCK`, whole post
    rolls back.
  - Alternative: revenue-only in 12a, defer stock consumption to a later slice. *The
    spec (§6.6) says 12a posts movements, so the default includes them.*
- **D3 — Daily-close uniqueness.** One active close per day.
  - **Recommended: a partial unique `(organization_id, sale_date) WHERE status <>
    'void'`** — at most one non-void sale per date; correcting a day = void the old one
    (retained as history) then create a new draft. A draft + a posted can't coexist for
    the same date.
  - Alternative: allow multiple sales per date (reference becomes free text).
- **D4 — Entitlement gate.** The spec says **Pro+ (`sales`)**, but there is **no
  `sales` feature** in `lib/entitlements.ts`/`clerk/billing.json` today.
  - **Recommended: add a new `sales` Clerk feature (Pro+)** — extend the `Feature`
    union, add it to `clerk/billing.json`, seed it in dev **and** prod Clerk, and gate
    via `requireFeature('sales')` **after** the `isManager()` check (RBAC → entitlement;
    kitchen still gets `FORBIDDEN` first, manager-wrong-plan → `UPGRADE_REQUIRED`).
    This is the only change needing a Clerk/ops action.
  - Alternatives: reuse the existing `invoices` feature, or ship all-plans. *Owner call.*
- **D5 — Tax rate source + the "rate required" gate.** Each line's `tax_rate_bps`
  **defaults from `organization_settings.default_tax_rate_bps`** and may be overridden
  per line. **Posting REQUIRES a configured org rate** (NULL → `SALES_TAX_RATE_REQUIRED`,
  surfaced as "set your VAT rate in Settings first"). No silent 0% (F5).
- **D6 — Draft lifecycle / deletion.** **Recommended: a draft sale is editable and
  HARD-deletable (no Trash — nothing financial is at stake yet); a posted/void sale
  is permanent history and is never trashed/edited** (mirrors a completed/voided
  production, L5 there). Optimistic concurrency on every mutation.
- **D7 — Audit metadata.** **Recommended: `sale.create/.update/.post/.void/.delete`
  with metadata = ids / line count / status transition / `stockMoved` / movement count
  only — NEVER the gross/net/tax amounts or any item name** (consistent with CLAUDE.md
  audit privacy, even though sale money is org-level not personal).
- **D8 — ⌘K search.** **Recommended: register a `sale` entity (manager-only), matched
  on `sale_date` + status, money-free subtitle.** Cheap parity with the other
  modules; can be dropped if the reviewer prefers.

---

## 2. Lifecycle & edit contract

```text
SALE:  draft ──(edit)──► draft
            └─(post)──► posted ──(void)──► void   (terminal; row retained)
       draft ──(delete)──► gone (hard delete; items cascade)
SALE LINE: created/edited/reordered/removed only while the parent sale is DRAFT.
```

- **Create / edit (draft only):** a manager builds the close: pick `sale_date`, add
  lines (item ref + units + unit net price + tax rate; for direct ingredients, canonical
  stock amount per sold unit). Totals are previewed live via `tax.ts` but **not** frozen
  until post.
- **Post (`draft → posted`):** under the sale row lock — (1) require a configured org
  tax rate; (2) lock/revalidate the referenced active recipe/menu/ingredient rows, the
  menu/recipe line rows needed for explosion, and all consumed ingredients/components in
  deterministic order; (3) recompute + FREEZE `item_name` and `net/tax/gross` on the
  sale + each line via `saleTotals` (do not trust draft preview totals); (4)
  `postSaleTransaction` writes the single protected income row (dedup + conflict); (5)
  decide `movesStock`; (6) when moving stock, explode → aggregate → `recordMovements`
  OUT (one per ingredient,
  `sale:<saleId>:agg:<ingredientId>` keys), which THROWS on a shortfall → whole
  `withOrg` rolls back; (7) flip status + stamp `posted_at` + `stock_moved` + audit. A
  terminal idempotent retry (already posted) is checked **before** the stale check,
  re-verifies the income row + frozen totals exist, and writes/audits nothing new.
- **Void (`posted → void`):** under the lock — `status='posted'` is voidable; an already
  `void` sale is an ok/no-op retry (no stale check, no audit, no second reversal);
  `voidSaleTransaction` soft-deletes the income row (F5); reverse each booked OUT
  movement with an equal-and-opposite F1 insert (`source_type='reversal'`, deterministic
  reversal keys based on the original movement id — adds stock back, can't breach the
  zero floor); stamp `voided_at` + audit. All in one `withOrg`.
- **Optimistic concurrency:** mutable paths carry `expectedUpdatedAt`, lock the sale row
  `FOR UPDATE`, compare, and return `SALE_STALE` before any write. Terminal idempotent
  retries (`posted` for post, `void` for void) are ok/no-op before the stale comparison,
  matching productions.

---

## 3. Data model — migration `0032`

Set journal `when` above the current maximum (0031 = 1782222881149). Add both tables
to `businessTables`, standard `org_isolation` RLS, and the account export; bump the
export schema version **12 → 13**. Generate with Drizzle; review SQL/meta/FK/CHECK/
index/RLS registration + journal order before local apply.

### `sales` (new)

- `id`, `organization_id`;
- `sale_date date NOT NULL` (bare 'YYYY-MM-DD' — the close date + reference);
- `status text NOT NULL DEFAULT 'draft'` (CHECK `IN ('draft','posted','void')`);
- `net_cents`, `tax_cents`, `gross_cents` integer NULL — **frozen on post** (NULL while
  draft); CHECKs: present iff `status IN ('posted','void')`, each `>= 0`, and
  `gross = net + tax`;
- `posted_at timestamptz NULL`, `voided_at timestamptz NULL` (CHECK: `posted_at`
  present iff `status IN ('posted','void')`; `voided_at` present iff `status = 'void'`);
- `stock_moved boolean NOT NULL DEFAULT false` (CHECK: true only when `status IN
  ('posted','void')` — freezes the F5 stock-control decision);
- `note text NULL`;
- `created_at`, `updated_at` (`$onUpdate`); **no `deleted_at`** (drafts hard-deleted;
  posted/void retained as history);
- indexes `(org)`, `(org, sale_date)`, `(org, status, sale_date)`; `unique (org, id)`
  (FK target); **partial unique `(org, sale_date) WHERE status <> 'void'`** (D3);
  pg_trgm GIN on a `sale_date::text`/reference is unnecessary — search matches the date
  string directly (D8).

### `sale_items` (new)

- `id`, `organization_id`, `sale_id text NOT NULL`;
- `item_kind text NOT NULL` (CHECK `IN ('recipe','menu','ingredient')`);
- `item_recipe_id`, `item_menu_id`, `item_ingredient_id` text NULL (D1);
- `item_name text NOT NULL` (draft preview name; re-frozen from the locked source row on
  post for historical render);
- `quantity integer NOT NULL` (CHECK `between 1 and 100000` — units sold);
- `ingredient_qty_canonical numeric(12,2) NULL` — required iff
  `item_kind='ingredient'`, else NULL; represents stock consumed per sold unit, so
  direct ingredient consumption = `quantity × ingredient_qty_canonical`;
- `unit_net_cents integer NOT NULL` (CHECK `>= 0`);
- `tax_rate_bps integer NOT NULL` (CHECK `between 0 and 10000`);
- `net_cents`, `tax_cents`, `gross_cents integer NOT NULL` (frozen line totals on
  post; for a draft they are computed-but-storable previews — **decision sub-point:**
  store live previews or leave 0 until post? **Recommended: recompute + store on every
  draft save** so the row is always self-consistent and the post just re-freezes);
  CHECKs each `>= 0`, `net = quantity × unit_net_cents`, and `gross = net + tax`;
- `sort_order integer NOT NULL DEFAULT 0` (CHECK `>= 0`);
- source-shape CHECK: exactly the one ref implied by `item_kind` is non-null, the other
  two null; `ingredient_qty_canonical` is non-null/positive only for ingredient lines;
- composite FK `(org, sale_id) → sales(org,id) ON DELETE cascade`;
- composite FKs `(org, item_recipe_id) → recipes`, `(org, item_menu_id) → menus`,
  `(org, item_ingredient_id) → ingredients`, all `ON DELETE restrict` (MATCH SIMPLE;
  NULL rows skip). Any sale line pins its catalogue item while it exists; draft lines
  are released only by editing/deleting the draft sale, while posted/void lines are
  permanent history. Surface this through the recipe/menu/ingredient purge guards
  before any side effect (extend them, §5);
- indexes `(org, sale_id)`, `(org, item_recipe_id)`, `(org, item_menu_id)`,
  `(org, item_ingredient_id)`.

---

## 4. Pure helpers — reuse, minimal new

- **Tax:** `lib/calculations/tax.ts` is already shipped + tested (`saleLineTotals`,
  `saleTotals`, `lineTax`, `bpsToPercent`/`percentToBps`). No change.
- **Consumption explosion (new, thin):** `lib/calculations/sale-consumption.ts` maps a
  sale's lines → an aggregated per-ingredient canonical requirement, REUSING
  `explodeProduction` for recipe lines (treat `units` as portions) and a menu→recipe
  expansion (menu line `units` × each menu item's recipe `quantity`), plus direct
  ingredient lines (`quantity × ingredient_qty_canonical`). Pure, returns
  `{ complete, requirements[], unavailableIds[] }` in the same shape family as the
  production explosion so the data layer can reuse the shortfall/movement plumbing.
  Tested for: recipe-only, menu, direct ingredient canonical quantity, mixed, trashed
  source/component → incomplete, overflow/invalid math → incomplete.

No costing anywhere in this module surface beyond the tax math — sales are revenue, not
cost.

---

## 5. Data layer — `lib/data/sales.ts`

All org-scoped, inside `withOrg`. Optimistic concurrency + `FOR UPDATE` on every
mutation (reuse the productions lock shape).

**Reads:** `listSales` (newest-first, with line counts + frozen gross for display),
`getSaleWithItems`, plus the loaders the editor needs (active recipe/menu/ingredient
options — reuse `listProductionRecipeOptions`/menu/ingredient option readers).

**Draft mutations:** `createSale` (draft + lines, validates the daily-close uniqueness
via the partial index → `DUPLICATE_NAME`-style `SALE_DATE_TAKEN`), `updateSale` (draft
only, optimistic; rewrites header + full line set, recomputing line totals via
`tax.ts`), `deleteSale` (hard delete of a draft). Draft create/update validates that
all referenced recipe/menu/ingredient rows are active at save time; posting re-checks
under locks so a race never posts stale catalogue data. The post path locks the source
catalogue rows and the final consumed ingredient set before calling
`postSaleTransaction` or `recordMovements`.

**Lifecycle:** `postSale` and `voidSale` — the two transactional cores (§2). `postSale`
reuses `postSaleTransaction` (F5), `saleTotals` (tax), `movesStock` (F5),
`buildMovementKey`/`recordMovements` (F1), and the new `sale-consumption` explosion;
returns audit-friendly counts (line count, ingredient count, `stockMoved`, movement
count) so the action logs them without re-querying or ever touching money. `voidSale`
loads the original `inventory_movements` by `(org, source_type='sale', source_id=saleId)`
and posts one reversal per OUT movement; financial-only sales have none to reverse.
`voidSaleTransaction` (F5) + F1 reversals are idempotent per L6/D6.

**Purge-guard coupling (extend, do not rewrite):** a `sale_item` with a non-null
`item_recipe_id`/`item_menu_id`/`item_ingredient_id` pins that catalogue row from purge
via restrict FKs; additionally, stock-moving sales pin consumed component ingredients
through `inventory_movements.source_type='sale'`. Extend:

- `recipe-purge.ts` → add a `sale` blocker (`countSalesUsingRecipe`) after menu and
  production in the stable priority order;
- `menus.ts`/menu purge action → add `countSalesUsingMenu` and return `MENU_IN_SALE`
  before `purgeMenu`;
- ingredient purge path → block when either `sale_items.item_ingredient_id` references
  the ingredient or any sale-sourced inventory movement consumed it; return
  `INGREDIENT_IN_SALE` before nulling task links or attempting delete;
- `lib/data/trash.ts` auto-purge → exclude expired menus/recipes/ingredients that are
  pinned by sale items or sale-sourced inventory movements, never null sale refs.

Posted/void sales are permanent history, so they legitimately keep their catalogue refs
alive; they are never unlinked-then-purged like the Sprint 6 task source links.

**Concurrency test (opt-in real Postgres):** two posts race on one draft → exactly one
posts (F5 dedup is the backstop); post vs. concurrent ingredient trash → the lock
serializes; void vs. void → exactly one reversal set.

---

## 6. Actions, validation, audit & errors

### Actions — `app/(app)/sales/actions.ts`

Canonical order per action: **RBAC (`isManager()`) → entitlement
(`requireFeature('sales')`, D4) → Zod → `withOrg`(mutation + audit) → revalidate.**
All sales actions are manager-only.

- `createSaleAction`, `updateSaleAction`, `deleteSaleAction` (draft lifecycle),
  `postSaleAction`, `voidSaleAction`.
- All input Zod-validated (`lib/validation/sales.ts`): `sale_date`/`tax_rate_bps`/
  units/prices/`ingredient_qty_canonical` real + in range, 1..N distinct lines,
  `expectedUpdatedAt` ISO, caps.
- `postSaleAction` maps the F5/F1 outcomes: `IDEMPOTENCY_CONFLICT` (different payload
  re-post or movement key conflict), `INSUFFICIENT_STOCK` (caught OUTSIDE `withOrg`,
  after rollback, like receipts/production-complete), `SALE_INCOMPLETE` (missing/
  trashed source/component or movement `not_found`), `SALES_TAX_RATE_REQUIRED` (no org
  rate).

### New action errors (`ActionErrorCode` + `actionErrors.*`)

- `SALE_STALE` (optimistic concurrency);
- `SALE_NOT_EDITABLE` (editing a posted/void sale);
- `SALE_DATE_TAKEN` (a non-void close already exists for that date, D3);
- `SALE_INCOMPLETE` (a line's recipe/menu component is trashed/missing);
- `SALES_TAX_RATE_REQUIRED` (org `default_tax_rate_bps` is NULL, D5);
- reuse `INVALID_STATUS_TRANSITION`, `INSUFFICIENT_STOCK`, `IDEMPOTENCY_CONFLICT`,
  `NOT_FOUND`, `INVALID_INPUT`, `FORBIDDEN`, `UPGRADE_REQUIRED`, plus the new purge
  guards `RECIPE_IN_SALE`/`MENU_IN_SALE`/`INGREDIENT_IN_SALE`.

### Audit (`AuditAction`) — metadata = ids/counts/status only, NEVER amounts/names

- `sale.create` / `.update` / `.delete` (saleId, lineCount);
- `sale.post` (saleId, lineCount, ingredientCount, stockMoved, movementCount,
  transactionId — **no money**);
- `sale.void` (saleId, reversalCount).

### Search / export plumbing

- Add `sale` to `SearchEntityType`, `searchSales` to `lib/search/queries.ts`, and a
  **manager-only** descriptor (`canAccess: canAccessFinancials`) in `SEARCH_REGISTRY`.
  Match on `sale_date` text + status; money-free subtitle (date + status + line count).
- Add `sales` + `saleItems` to `lib/data/account-export.ts`, bump
  `ACCOUNT_EXPORT_SCHEMA_VERSION` **12 → 13** with a version comment.

---

## 7. UI

- **`/sales`** (new nav + sidebar entry, **Finance group → manager-only**, e.g.
  `ShoppingCart`/`Receipt` icon): a list of daily closes (date, status badge, line
  count, frozen gross), New-close button. A clear banner: *"Sales post revenue
  automatically — don't also import it from your bank"* (the accepted v1 double-count
  limitation, F5).
- **`/sales/[id]`**: the close editor (draft) / read-only view (posted/void). Lines:
  item picker (recipe/menu/ingredient), units, unit net price, tax rate (defaults from
  org), and for direct ingredient lines the canonical stock amount consumed per sold
  unit; live net/tax/gross preview via `tax.ts`; Post / Void / Delete (draft) buttons.
  A posted close shows the linked transaction; when `stock_moved=true`, it also shows
  the booked consumed-ingredients readout from the F1 movements. Financial-only posted
  sales show an explicit "stock not posted for this date" state. A void close shows the
  reversal count.
- **Entitlement:** managers on a plan without `sales` see `<UpgradeRequired>` (→
  `/pricing`); document routes (if any PDF later) return HTTP 402.
- **⌘K:** `sale` entity (manager-only) → `/sales/[id]`.
- **a11y/mobile + i18n:** all copy in `en.json` (`sales.*`) + the new `actionErrors.*`.

---

## 8. Test matrix

### Pure
- `tax.ts` (already covered); `sale-consumption` over recipe / menu / direct ingredient
  canonical quantity / mixed / trashed-source-or-component-incomplete /
  overflow-incomplete.

### PGlite / data / RLS
- Create draft + lines; line totals reconcile (Σ rounded lines = sale gross).
- DB CHECKs reject: bad status, money present on a draft / absent on a posted,
  `line.net_cents ≠ quantity × unit_net_cents`, `gross ≠ net + tax`, bad source shape
  (kind without its ref / with a foreign ref), missing or non-positive
  `ingredient_qty_canonical` on ingredient lines, non-null `ingredient_qty_canonical`
  on recipe/menu lines, qty/bps out of range, a second non-void close on the same date
  (partial unique).
- **Post writes exactly ONE protected `income` row = gross, `daily_sales` category,
  `source_type='sale'`** (via the F5 primitive); a re-post with the same payload is
  `deduped` (no second row), a different payload is `IDEMPOTENCY_CONFLICT`.
- **Stock:** post on/after the start date writes one idempotent OUT movement per
  ingredient (aggregated keys `sale:<saleId>:agg:<ingredientId>`); post BEFORE the
  start date is financial-only (`stock_moved=false`, no movements); an oversized
  stock-out rejects the WHOLE post (no income row, no partial movements).
- **Void:** soft-deletes the income row (F5 path) + posts equal-and-opposite F1
  reversals; a second void is an ok/no-op with **no second reversal and no second
  audit**; the voided sale row is retained with frozen values.
- Protected: a sale-sourced transaction can't be edited/trashed/purged manually and is
  skipped by `purgeExpired` (already F5 — add a sale-driven regression).
- Purge guards: a recipe/menu/ingredient referenced by any sale line, and an ingredient
  referenced by any sale-sourced inventory movement, is purge-blocked (`*_IN_SALE`)
  before any side effect; auto-purge excludes those rows.
- Composite-FK + unfiltered `tenant_app` isolation for both tables; export schema **v13**
  contains both tables and no foreign-tenant rows.

### RBAC / entitlements
- Every sales action returns `FORBIDDEN` for kitchen **before** data access; a
  manager on a plan without `sales` gets `UPGRADE_REQUIRED` **after** the role check,
  **before** data (D4); ⌘K `sale` descriptor is manager-only.

### Audit / concurrency
- `sale.*` audit once, in-tx; metadata carries **no amounts or item names**; idempotent
  re-post / second void don't double-audit.
- Real-PG opt-in: concurrent post → single income row + single movement set; post vs.
  ingredient-trash serializes.

---

## 9. Out of scope (Sprint 12a)

- **Sales import** (staged, dedup on external key) → **Sprint 12b**.
- **Inventory depth** (storage areas, per-area counts, transfers) → **Sprint 12c**.
- **Bank reconciliation / double-count prevention** — explicit accepted v1 limitation
  (the UI only warns); reconciliation is a later sprint.
- Per-ticket / real-time POS, refunds & partial returns, multi-rate or inclusive tax,
  tips/discounts/service charges, produced-good stocking.

---

## 10. Definition of Done

- `npm run lint && npm run typecheck && npm test && npm run build` green.
- Migration `0032` generated, SQL/meta/journal reviewed, migrate-guard green, applied
  **locally only**; RLS verified `tenant_app` for both tables; status/money/source CHECKs
  verified.
- Post proves the single protected income row (= gross, dedup + conflict) and idempotent
  stock consumption (incl. the financial-only skip + insufficient-stock rollback).
- Void proves the 6-point retention contract end-to-end (atomic flip + income
  soft-delete + reversal + retained row + idempotent second void).
- Manager-only + `sales` entitlement proven by RBAC-before-entitlement-before-data tests.
- Purge guards (`*_IN_SALE`), ⌘K, export v13, audit (no amounts/names), i18n wired/tested.
- **EXTERNAL GATE:** the accountant has signed off on **line-level rounding + the
  exclusive single-rate model** for the jurisdiction (§7 of the expansion plan) — this
  blocks *shipping* 12a, not building/reviewing it.
- **D4 (entitlement) resolved** and, if "add a `sales` feature", the Clerk catalogue is
  updated in dev **and** prod and `clerk/billing.json` committed.
- No migration reaches production without separate owner review/authorization.

---

## 11. Codebase anchors

- F5 primitives + contract: `lib/data/transactions.ts` (`postSaleTransaction`,
  `voidSaleTransaction`, `DAILY_SALES_CATEGORY_SLUG`, the protected-row backstops),
  `docs/sales-transaction-contract.md`; tax `lib/calculations/tax.ts`; stock-control
  `lib/finance/stock-control.ts`; the F5 schema bits in `lib/db/schema.ts`
  (`transactions.source_type/source_id`, `transactions_org_source_key`,
  `transactions_source_pair_chk`, `organization_settings.default_tax_rate_bps`/
  `stock_control_start_date`).
- F1 ledger: `lib/data/inventory.ts` (`recordMovements`, `buildMovementKey`,
  `MovementError`).
- Explosion to reuse: `lib/calculations/production.ts` (`explodeProduction`,
  `shortfallVsStock`); the production lifecycle to mirror: `lib/data/productions.ts`
  (`completeProduction`/`voidProduction` + `lockProductionForUpdate`), its actions
  `app/(app)/productions/actions.ts` (MovementError caught outside `withOrg`).
- Purge guards to extend: `lib/data/recipe-purge.ts`, the menu/ingredient purge paths,
  `lib/data/trash.ts`.
- Entitlements: `lib/entitlements.ts` (+ `clerk/billing.json`), `components/app/
  upgrade-required.tsx`.
- Plumbing: `lib/db/schema.ts` + `businessTables`, `lib/db/rls.ts`,
  `lib/data/account-export.ts` (v12→v13), `lib/data/audit.ts`, `lib/action-result.ts`,
  `lib/search/{queries,registry,types}.ts`, `lib/nav.ts`, `components/app/sidebar.tsx`,
  `components/app/command-palette.tsx`, `drizzle/meta/_journal.json`, i18n messages.

---

## 12. Owner confirmations before coding

Defaults above are approved by this review; these are the owner-facing switches to
override deliberately, not blockers if the owner accepts the defaults.

1. **D1** — sale-line item model (typed recipe/menu/ingredient ref + frozen name +
   `ingredient_qty_canonical` for direct ingredient lines vs. also allow free-text/
   no-ref revenue lines).
2. **D2** — include stock consumption (explode recipe/menu → ingredients) in 12a as the
   spec states, or split it out and ship revenue-only first?
3. **D3** — one non-void close per `sale_date` (partial unique), or allow multiples?
4. **D4** — entitlement: add a new `sales` Clerk feature (Pro+, needs a dev+prod Clerk
   catalogue change) vs. reuse `invoices` vs. all-plans?
5. **D5/D6** — confirm "rate required before posting" + draft hard-delete / posted-void
   immutability.
6. **Process** — accountant sign-off on rounding + exclusive single-rate is the only
   external gate; OK to build + review 12a in parallel and hold the *merge/prod-migrate*
   until that sign-off + your diff review?
7. Any objection to bumping the account export to **v13** and to migration **0032**
   staying local until the diff review?
