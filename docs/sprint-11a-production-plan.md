# Sprint 11a — Production planning + recipe explosion — implementation plan

> **Status: SENIOR-REVIEWED v2 — decisions locked; implementation NOT started.**
> Source of truth: `docs/expansion-plan-kitchen-ops.md` §5/§6.5/§8, F3, F4 and
> the shipped Sprint 10 Menus module. Migration `0029` is **LOCAL only** until its
> generated SQL/meta diff is reviewed and the owner explicitly authorizes production.

## 0. Outcome and non-negotiable boundaries

11a creates a production plan (`recipes × planned portions`) and derives, on read:

1. the aggregated canonical ingredient requirement (mise-en-place);
2. current on-hand stock and shortfall; and
3. for managers only, the current estimated production cost.

11a is planning, not posting. It writes **zero inventory movements**, never changes
`ingredients.stock_quantity`, stores no derived requirement/cost, and creates no F3
historical snapshot. Completion, frozen snapshots, idempotent F1 OUT movements and
reversals belong together in 11b.

The two calculations remain deliberately separate:

- **operational quantity:** visible to kitchen and manager;
- **money:** server-returned only to managers, with the key absent from kitchen DTOs.

Shortfall is an **instantaneous advisory**, not a reservation. Two plans may both see
the same on-hand stock; 11a does not allocate or reserve inventory.

---

## 1. Decisions LOCKED

1. **D1 — Components:** recipes only in v1. No raw-ingredient lines, menus, nested
   recipes or recursive BOM.
2. **D2 — Quantity:** `planned_qty` means integer portions, `1..100000`; one recipe
   appears at most once per production.
3. **D3 — Snapshot boundary:** `draft` and `planned` are both **pre-post operational
   states**. Recipe lines, prices and stock remain live. 11b captures the immutable
   server-built snapshots under the same lock/transaction that completes the run.
4. **D4 — Recipe purge:** any surviving `production_item` blocks recipe purge with
   `RECIPE_IN_PRODUCTION`, regardless of production status or Trash state. This is a
   deliberate catalogue-integrity rule (the stricter Menus precedent), not a claim
   that a draft is already an F3 historical document.
5. **D5 — Two metrics:** explosion/shortfall and production cost are independent.
   Changing an ingredient price changes manager cost, never required quantity.
6. **D6 — Lifecycle/Trash:** 11a plans use soft-delete + 30-day Trash. In 11b,
   completed/voided runs become permanent history and are excluded from Trash.
7. **D7 — RBAC:** kitchen and manager may create, edit, plan, reopen and soft-delete
   plans. Kitchen payloads stay money-free. Restore/purge in Trash remain manager-only.
   There is no feature-plan gate.
8. **D8 — Status scope:** migration `0029` contains only `draft|planned`. 11b widens
   the CHECK to `draft|planned|completed|voided` in the same migration that adds
   snapshots and posting invariants. Do **not** pre-create unreachable
   `completed/cancelled` states in 11a; `cancelled` also conflicts with the established
   reversal term `voided`.
9. **D9 — Search:** ship ⌘K search in 11a. Match active productions on reference and
   notes; return no monetary subtitle.
10. **D10 — Shared cost sum:** extract a generic `componentCost` and keep `menuCost`
    as a backwards-compatible adapter. Menus and Production must share the same
    complete-or-null and safe-integer behavior.

Additional contracts:

- `reference` is optional, non-unique free text — never a counter.
- A saved production has `1..100` distinct recipe items.
- A planned production must have `planned_for`, all recipes active, and a complete,
  finite explosion within the `numeric(12,2)` quantity domain.
- Unavailable components never become zero quantity or zero cost.
- No accounting sign-off is required: 11a touches neither fiscal data nor stock.

---

## 2. State machine and edit contract

```text
create -> draft -> planned
           ^          |
           +-- reopen-+

draft/planned -> Trash -> restore (same prior status)
Trash -> purge after retention/manual manager action
```

- **Create:** produces `draft`.
- **Update items/header:** allowed only while `draft`.
- **Plan:** `draft -> planned`; locks the production and referenced recipes, requires
  `planned_for`, active recipes and a complete explosion. It stores no calculation.
- **Planned:** read-only. To change it, explicitly `reopen` to draft, then edit.
- **Reopen:** `planned -> draft`; audited, no stock effect.
- **Soft-delete:** allowed for either pre-post state. Restore preserves its prior
  status because soft-delete is only `deleted_at`.
- **11b completion:** only `planned -> completed`; `completed -> voided` by reversal.

Every update/state/delete form carries `expectedUpdatedAt`. The data layer locks the
row, compares it, and returns `PRODUCTION_STALE` before any write/audit on mismatch.
This prevents silent last-writer-wins when kitchen and manager edit the same plan.

---

## 3. Data model — migration `0029`

Set journal `when` above the current maximum. Add both tables to `businessTables`,
standard `org_isolation` RLS, account export and seeds/fixtures where applicable.
Account export schema version: **9 -> 10**.

### `productions`

- `id`, `organization_id`;
- `reference text NULL` (trimmed free text, max 200 at the action boundary);
- `notes text NULL` (max 1000);
- `status text NOT NULL DEFAULT 'draft'`;
- `planned_for date NULL` (bare `YYYY-MM-DD`, no timezone conversion);
- `created_at`, `updated_at`, `deleted_at timestamptz NULL`.

Constraints/indexes:

- CHECK `status IN ('draft','planned')`;
- `unique (organization_id, id)` for same-org child FK;
- indexes `(org)`, `(org, deleted_at)`, `(org, status, planned_for)`;
- pg_trgm GIN on `reference` and `notes` because D9 searches both.

`planned_for IS NOT NULL` is enforced by the transactional `plan` transition rather
than a row CHECK, so an incomplete draft can be saved.

### `production_items`

- `id`, `organization_id`;
- `production_id text NOT NULL`;
- `recipe_id text NOT NULL`;
- `planned_qty integer NOT NULL`;
- `sort_order integer NOT NULL DEFAULT 0`.

Constraints/indexes:

- composite FK `(org, production_id) -> productions(org,id) ON DELETE cascade`;
- composite FK `(org, recipe_id) -> recipes(org,id) ON DELETE restrict`;
- unique `(org, production_id, recipe_id)`;
- CHECK `planned_qty BETWEEN 1 AND 100000`;
- CHECK `sort_order >= 0`;
- indexes `(org, production_id)` and `(org, recipe_id)`.

Generate with Drizzle; do not hand-author the migration. Review SQL, snapshot/meta,
FK names, CHECKs, indexes, RLS registration and journal order before local apply.

---

## 4. Pure calculations — `lib/calculations/production.ts`

### Explosion

For each active recipe line:

```text
canonicalNeeded = line.quantity
                * plannedQty
                / recipe.yieldPortions
                / (recipe.yieldPercentage / 100)
```

This is the exact yield/loss convention already used by `recipeCost.ts`.

Calculation rules:

- validate non-empty items, distinct recipe ids, positive integer portions, valid
  yield and finite non-negative line quantities;
- single-level only: input accepts recipe ingredient lines, not recipe components;
- accumulate **unrounded** contributions by `ingredientId` across every recipe;
- round once, after aggregation, to 2 canonical decimals using one exported helper;
- reject non-finite/negative values and a final amount above the PostgreSQL
  `numeric(12,2)` domain; never clamp silently;
- sort output by `ingredientId` for deterministic tests and future 11b posting.

Use a discriminated result so partial data cannot be mistaken for a final list:

```ts
type ProductionExplosion =
  | {
      complete: true;
      requirements: IngredientRequirement[];
      unavailableRecipeIds: [];
    }
  | {
      complete: false;
      partialRequirements: IngredientRequirement[];
      unavailableRecipeIds: string[];
      reason: 'recipe_unavailable' | 'invalid_math' | 'overflow';
    };
```

Only active recipes contribute to `requirements`. For an incomplete result, the UI
may show `partialRequirements` as a clearly labelled preview, but must not present it
as a final mise-en-place/order list. A production cannot transition to `planned` while
incomplete; 11b will likewise refuse completion.

### Shortfall

`shortfallVsStock(requirements, onHand)` returns:

```text
shortfall = max(0, needed - onHand)
```

Round/normalize at the same two-decimal boundary. Detail DTOs include `calculatedAt`
and `isReservation: false`; copy states that refresh/reload may change on-hand values.
Do not calculate an actionable shortfall from an incomplete explosion.

### Cost

Create `lib/calculations/componentCost.ts` with the generic sum:

```text
sum(costPerPortionCents * quantity)
```

It returns a discriminated complete result only when every component is available
and the total is a finite, non-negative safe integer. `menuCost` delegates to it, so
existing imports/API/tests need not be rewritten. Production uses it with
`plannedQty`. No new cost formula is introduced.

---

## 5. Data layer — `lib/data/productions.ts`

All functions receive a `TenantClient` and explicit `organizationId`, run inside
`withOrg`, and include org predicates even with RLS.

### Role-safe loaders (F4 by construction)

Keep distinct exported types and explicit Drizzle projections:

- `listKitchenProductions`: identity, reference, notes, state/date, item count and
  completeness only. No full explosion on every list row.
- `getKitchenProduction`: header/items/recipe names/availability plus complete
  explosion and shortfall. It selects stock/dimension but **never** price, hidden
  recipe costs or selling price and never calls a cost helper.
- `listManagerProductions`: kitchen list fields plus current production cost.
- `getManagerProduction`: kitchen detail fields plus current production cost and
  per-recipe cost where useful.

Kitchen DTO types have no `costCents`, `costPerPortionCents`, `priceCents`,
`laborCostCents`, `energyCostCents` or `packagingCostCents` keys. Key absence — not
zero/null/redaction after loading — is the security contract.

### Batched reads

For a detail/read batch:

1. load active production headers;
2. load all items ordered by `(production_id, sort_order)`;
3. load distinct recipes, including trashed rows, for name + availability;
4. load recipe lines and ingredient `dimension`/`stock_quantity` in one query;
5. for manager loaders only, separately select the monetary recipe/ingredient fields
   and run `recipeCost` once per distinct recipe;
6. compute explosion per production and shortfall only for complete explosions.

Do not filter trashed ingredients out of historical recipe lines; mirror current
recipe costing. Missing rows are treated as unavailable/corrupt, never silently
dropped. List loaders must avoid N+1 and avoid loading full stock data when the list
does not display requirements.

### Mutations and locks

- `createProduction`;
- `updateDraftProduction`;
- `planProduction`;
- `reopenProduction`;
- `softDeleteProduction`;
- `restoreProduction`;
- `purgeProduction`;
- `countProductionsUsingRecipe` / shared recipe purge guard.

Mutation contract:

- validate before data access;
- lock production row `FOR UPDATE` for update/state/delete;
- compare `expectedUpdatedAt` and enforce the state transition;
- lock distinct recipe rows `FOR UPDATE` in ascending id order before inserting or
  replacing lines, reasserting same-org + active;
- replace header/items atomically; any failure rolls back the whole change;
- `planProduction` recomputes completeness under those locks;
- map missing/cross-org/trashed recipes to `PRODUCTION_RECIPE_INVALID`;
- return narrow outcomes, never a raw DB exception to the action.

Real PostgreSQL opt-in tests cover concurrent edit/plan versus recipe trash and a
stale edit. PGlite remains the main functional suite.

---

## 6. Recipe Trash/purge coupling

Generalize the shipped Menus guard to return deterministic blockers, for example
`Set<'menu' | 'production'>`. Preserve existing `RECIPE_IN_MENU`; map a production
pin to `RECIPE_IN_PRODUCTION`. If both exist, use a documented stable priority
(Menus first for backwards compatibility) and test it.

Manual recipe purge:

1. evaluate blockers **before** unlinking `transactions.recipe_id`;
2. return the blocker code with zero side effects;
3. only the `ok` branch unlinks transactions and purges the recipe.

`purgeExpired` ordering/candidate contract:

1. purge expired productions and menus first (their cascades release recipe pins);
2. build one `purgeableRecipeWhere` excluding surviving `menu_items` **and**
   `production_items` references;
3. use that exact candidate set for both transaction unlink and recipe delete;
4. continue with ingredient/customer/invoice purge order.

Extend `PurgeResult` with `productions`; update Trash UI, cron totals/JSON/audit,
routes, tests and cache revalidation. A trashed but not-yet-expired production still
pins its recipe.

---

## 7. Actions, validation, audit and errors

### Actions — `app/(app)/productions/actions.ts`

- `createProductionAction`;
- `updateProductionAction`;
- `planProductionAction`;
- `reopenProductionAction`;
- `deleteProductionAction`;
- manager-only Trash restore/purge actions.

Kitchen is allowed on the first five after authentication/org resolution. Trash
restore/purge checks `isManager` and returns `FORBIDDEN` **before data access**.

Order: auth/role -> Zod -> `withOrg` mutation + audit in one transaction -> targeted
revalidation (`/productions`, detail, `/trash`, search consumers). An error/no-op
does not audit.

### Validation — `lib/validation/productions.ts`

- reference trimmed/null, max 200;
- notes trimmed/null, max 1000;
- `plannedFor` valid bare calendar date or null;
- items `1..100`, recipe id non-empty, quantity integer `1..100000`;
- duplicate recipe ids rejected before DB;
- `expectedUpdatedAt` is a valid server-issued timestamp on non-create mutations;
- no client field for cost, stock, explosion, status snapshot or movement.

### New action errors

- `PRODUCTION_RECIPE_INVALID`;
- `PRODUCTION_NOT_EDITABLE`;
- `PRODUCTION_INCOMPLETE`;
- `PRODUCTION_STALE`;
- `RECIPE_IN_PRODUCTION`.

Add every code to `ActionErrorCode` and `actionErrors.*` in all locales.

### Audit

Add `production.create`, `.update`, `.plan`, `.reopen`, `.delete`. Restore/purge use
generic Trash actions with `entityType='production'`. Metadata may include item
count, total planned portions, status transition and changed field names; it must
never contain cost, price or ingredient financial fields.

---

## 8. UI and search

### `/productions`

Both roles see reference/fallback label, status, planned date, item count and an
incomplete marker. Managers additionally see current estimated cost. Fallback label
for empty reference: planned date when present, otherwise localized “Production” +
short id. New control is visible to both roles.

### `/productions/[id]`

- draft editor: active-recipe picker, unique rows, portions and planned date;
- planned view: read-only with explicit Reopen action;
- requirements: ingredient, needed, on-hand and shortfall;
- “calculated at” + “not reserved” copy;
- incomplete state: prominent blocking warning; optional partial preview is labelled
  non-actionable and has no “order N” callout;
- manager-only current cost card; the kitchen server payload has no money key;
- Plan action disabled/refused until date + completeness requirements pass.

Add Production to the Operations nav for both roles. Use `productions.*` i18n and
cover empty/loading/error/focus/keyboard/responsive states.

### ⌘K

Add `production` to the search entity union/registry and `searchProductions`:

- active rows only;
- reference + notes trigram/ILIKE matching;
- identity/status/planned date only, no monetary subtitle;
- kitchen accessible;
- deep-link `/productions/[id]`;
- tests for registry, ranking, tenant isolation and money-key absence.

---

## 9. Test matrix

### Pure calculations

- one recipe and multi-recipe aggregation;
- same ingredient across recipes, with rounding **once after aggregation**;
- yield portions + loss percentage reconciles with `recipeCost` convention;
- deterministic ordering;
- unavailable recipe -> discriminated incomplete result, never zero;
- invalid math/overflow rejected, never clamped;
- shortfall: zero, exact, partial, over-stock and incomplete refusal;
- component cost complete/incomplete/overflow; existing Menus behavior unchanged.

### PGlite/data/RLS

- create/update/reorder, state transitions and invalid transition rejection;
- planned date/completeness required for `draft -> planned`;
- planned rows immutable until reopen;
- stale `updatedAt` rejects with zero writes/audit;
- duplicate, missing, trashed and cross-org recipes rejected;
- composite-FK and unfiltered `tenant_app` isolation;
- price change moves manager cost but not explosion;
- stock change moves shortfall but neither requirement nor cost formula;
- trashed component makes plan incomplete; restore recovers;
- every 11a mutation leaves movement count and stock unchanged;
- soft-delete/restore/purge and recipe purge blocker with no partial transaction unlink;
- expired production purges before recipe; surviving/young Trash production pins it;
- export schema v10 contains both new tables and no foreign tenant rows.

### F4/RBAC/serialization

- kitchen list/detail SQL and DTO contain no financial selection/key;
- serialized RSC/action payload has no money key;
- kitchen create/update/plan/reopen/delete succeeds without echoing cost;
- manager loader returns cost;
- kitchen Trash restore/purge is forbidden before data access;
- search result carries no money for either role.

### Audit/cron/routes/concurrency

- successful mutations audit exactly once in the same org/transaction;
- refused/no-op/stale operations do not audit;
- metadata contains no money;
- cron result, totals and audit include `productions`;
- real-PG opt-in: concurrent recipe trash versus save/plan preserves a valid outcome;
  concurrent stale edit cannot silently overwrite the winner.

---

## 10. Out of scope

- inventory ledger writes, stock reservation or allocation;
- completion/void/reversal/idempotency and insufficient-stock policy (11b);
- completion snapshots/PDFs (11b);
- sub-recipes/nested explosion or stockable produced recipes;
- kitchen tasks (11c), labour/time scheduling, calendar, sales/menu linkage;
- new costing logic or stored derived totals.

---

## 11. Definition of Done

- `npm run lint && npm run typecheck && npm test && npm run build` green.
- Migration `0029` generated, SQL/meta/journal reviewed, migrate guard green, applied
  locally only; RLS verified as `tenant_app`.
- State machine, optimistic concurrency and no-stock-write invariant proven.
- Explosion uses live recipe quantities, aggregates before rounding, exposes no
  actionable partial result, and marks shortfall as non-reserved.
- F4 proven by separate projections/types and serialized key absence.
- Recipe purge and auto-purge share side-effect-safe candidate/blocker semantics.
- Export v10, Trash, cron, search, nav, i18n and audit are wired and tested.
- `docs/sprint-11a-production-plan.md` committed.
- No migration reaches production without separate owner review/authorization.

---

## 12. Codebase anchors

- Menus precedent: `lib/data/menus.ts`, `lib/calculations/menu.ts`,
  `app/(app)/menus/*`, `tests/menus.test.ts`.
- Cost/yield: `lib/calculations/recipeCost.ts`.
- Recipe lines and locking: `lib/data/recipes.ts`, `lib/data/recipe-ingredients.ts`.
- Stock read: `ingredients.stock_quantity`, `lib/data/ingredients.ts`.
- F4: explicit kitchen/manager recipe and menu loaders + RBAC tests.
- Trash/purge: `lib/data/trash.ts`, `lib/data/menus.ts` recipe guard,
  `app/(app)/trash/*`, purge cron.
- Search: `lib/search/{types,registry,queries}.ts`, command palette.
- Plumbing: `lib/db/schema.ts`, `businessTables`, `lib/db/rls.ts`,
  `lib/data/account-export.ts`, `lib/data/audit.ts`, `lib/action-result.ts`, `lib/nav.ts`,
  i18n messages, `drizzle/meta/_journal.json`.

---

## 13. Verification walkthrough

1. Manager creates a draft with two recipes, sets date, plans it; detail becomes
   read-only and requirements match hand calculation.
2. Kitchen sees the same operational data, creates/reopens/edits/plans, but its HTML,
   RSC and action payload contain no financial key.
3. Change ingredient price: only manager cost changes. Change stock: only shortfall
   changes. No movement row appears in either case.
4. Trash a component recipe: plan becomes incomplete and cannot be planned/completed;
   restore recovers it. Purge while referenced returns `RECIPE_IN_PRODUCTION` without
   unlinking transactions.
5. Submit two edits from the same version: the winner commits; the loser gets
   `PRODUCTION_STALE` with no partial rows/audit.
6. Purge an expired production: items cascade, counters/audit update, and a formerly
   pinned expired recipe becomes purgeable in the same run.

---

## 14. Handoff to Sprint 11b

11b owns the single critical transition `planned -> completed`. Under deterministic
id-ascending locks and one transaction it will:

- widen status to `completed|voided` and add completion/void timestamps;
- freeze server-built recipe/portion-cost and exploded ingredient snapshots;
- enforce stock-control start date and insufficient-stock policy;
- write idempotent F1 OUT movements keyed by production + ingredient;
- make completed rows permanent and void only by reversal.

Until 11b exists, no 11a code may write `completed`, `voided` or an inventory movement.
