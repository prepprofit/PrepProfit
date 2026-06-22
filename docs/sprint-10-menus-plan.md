# Sprint 10 — Menus / Combos — implementation plan

> **Status: DRAFT v2 — senior-reviewed and implementation-ready after owner approval.**
> Nothing is implemented yet. Migration `0028` is **LOCAL only** and must not be
> applied in production before its generated SQL/meta diff is reviewed. Source:
> `docs/expansion-plan-kitchen-ops.md` §6.4 + the F4 money-visibility contract
> (`docs/sprint-f4-plan.md`). This sprint reuses the existing recipe cost, margin,
> and allergen engines; it adds only menu aggregation and food-cost presentation.

## Context

A menu/combo groups recipes sold together at one price. Sprint 10 delivers the
profitability half of menu engineering: live component cost, food-cost %, and gross
margin. Popularity/sales-mix analysis remains deferred until sales can reference a
menu.

- **Derive on read:** menu cost is the live sum of each recipe's current
  `costPerPortionCents × quantity`; cost is never stored.
- **Money is persisted:** `selling_price_cents` is a financial mutation even though
  this sprint has no ledger movement. It is manager-only and audited.
- **F4 by construction:** kitchen queries and DTOs never select, compute, or
  serialize menu price, recipe/ingredient costs, food-cost %, margin, or traffic
  light. Keys are absent, never zeroed.
- **Allergen safety:** the menu rollup is the max-presence union of all component
  recipes and propagates `hasUnreviewedIngredient`. Trashing a recipe never silently
  removes its allergens.

## Decisions LOCKED

1. **D1 — Recipes-only components.** `menu_items` references recipes only. Raw
   ingredients and nested menus are out of scope.
2. **D2 — Quantity means portions, integer `1..1000`.** A recipe may appear only
   once per menu; changing the quantity represents multiples such as `2 × Fries`.
3. **D3 — No snapshot.** A menu is a live planning/catalogue artifact, not an F3
   issued document. Costs derive on read and move when recipe/ingredient costs move.
4. **D4 — Soft-delete + 30-day Trash.** Menus mirror recipes: active, trashed,
   restorable, then purgeable.
5. **D5 — Preserve composition; purge-block recipes.** Trashing a component recipe
   is allowed and marks the line unavailable. It does **not** turn the line into a
   zero-cost component: the menu's financial calculation becomes `incomplete` and
   price/margin KPIs are withheld. A recipe referenced by any menu cannot be purged;
   the manager removes/replaces the line or purges the menu first. No automatic
   deletion of `menu_items` from a surviving menu.
6. **D6 — All plans; role split.** Both roles may read active menus. Kitchen is
   read-only and money-free. All menu mutations, including selling price, are
   manager-only; no Clerk feature gate.
7. **D7 — Flat list.** No menu folders or nesting in v1.
8. **D8 — Audit mutations.** Add `menu.create`, `menu.update`, and `menu.delete`.
   Restore/purge use existing `trash.restore` / `trash.purge` with
   `entityType='menu'`. Audit metadata contains ids, item counts and a
   `priceChanged` boolean, never notes or menu price values.

Additional locked contracts:

- Menu names are non-unique, matching recipes.
- A saved menu has `1..100` items; there is no draft/empty-menu state.
- `selling_price_cents` may be `NULL` or zero. Food-cost %, margin, and traffic light
  are **undefined (`null`)** when price is absent/non-positive or calculation is
  incomplete; the UI renders `—`, never a misleading `0%`.

---

## 1. Data model — migration `0028`

Set the new journal `when` above the current maximum. Add both tables to
`businessTables` (standard `org_isolation` RLS) and to `buildOrgDataExport`; bump
account-export **8 → 9**.

### `menus`

`id`, `organization_id`, `name text NOT NULL`, `selling_price_cents integer NULL`,
`notes text NULL`, `created_at`, `updated_at`, `deleted_at timestamptz NULL`.

- `unique (organization_id, id)` — same-org FK target.
- indexes `(org)`, `(org, name)`, `(org, deleted_at)`.
- pg_trgm GIN on `name` for global search.
- CHECK `selling_price_cents IS NULL OR selling_price_cents >= 0`.

### `menu_items`

`id`, `organization_id`, `menu_id text NOT NULL`, `recipe_id text NOT NULL`,
`quantity integer NOT NULL DEFAULT 1`, `sort_order integer NOT NULL DEFAULT 0`.

- FK `(org, menu_id) → menus(org,id) ON DELETE cascade`.
- FK `(org, recipe_id) → recipes(org,id) ON DELETE restrict`.
- unique `(org, menu_id, recipe_id)` — one row per recipe per menu.
- CHECK `quantity BETWEEN 1 AND 1000`; CHECK `sort_order >= 0`.
- indexes `(org, menu_id)` and `(org, recipe_id)`.

The schema diff must be reviewed for composite-FK names, CHECKs, indexes, RLS
registration, and journal ordering before local application.

---

## 2. Pure calculations — `lib/calculations/menu.ts`

No new ingredient-cost model is introduced. Manager loaders compute every recipe
with the existing `recipeCost()` and pass per-portion integers into the menu helper.

```ts
type MenuCostLine = {
  recipeId: string;
  quantity: number;
  costPerPortionCents: number | null; // null = unavailable/incomplete
};

type MenuCostResult =
  | { complete: true; costCents: number; unavailableRecipeIds: [] }
  | { complete: false; costCents: null; unavailableRecipeIds: string[] };
```

- `menuCost(lines)` sums `costPerPortionCents × quantity` only when every line is
  available and the result is a non-negative safe integer. It returns incomplete;
  it never substitutes zero for a missing component.
- `foodCostPercent(costCents, priceCents): number | null` returns one-decimal
  `cost / price × 100`, or `null` when inputs are unavailable/price ≤ 0.
- Existing `marginPercent` and `trafficLight` are called only when calculation is
  complete and price > 0; otherwise manager DTO fields are `null`.
- Tests cover empty/invalid inputs defensively, missing component, zero/null price,
  rounding, negative margin, exact thresholds, and safe-integer overflow.

---

## 3. Data layer — `lib/data/menus.ts`

### Explicit role-safe read paths

Do not load a full money-bearing model and strip it late. Provide two loader
families with explicit Drizzle projections:

- `listKitchenMenus` / `getKitchenMenu` select menu identity/notes, item ids,
  recipe names, quantities, recipe availability, and allergen rollups only. They do
  **not** select `menus.selling_price_cents`, recipe hidden/selling costs, or
  `ingredients.price_cents`, and never invoke `recipeCost`/margin helpers.
- `listManagerMenus` / `getManagerMenu` select the financial columns and compute
  costs/KPIs server-side.

Kitchen and manager DTOs are separate types. Kitchen types cannot structurally
contain `sellingPriceCents`, `costPerPortionCents`, `costCents`,
`foodCostPercent`, `marginPercent`, or `trafficLight`.

### Batched manager costing

For list/detail views, avoid N+1:

1. load active menus;
2. load all their menu items;
3. load the distinct referenced recipes, including trashed rows so availability is
   visible rather than silently dropping a line;
4. load all recipe lines + ingredient name/dimension/current price in one query;
5. compute each distinct recipe once with `recipeCost`, cache by recipe id, then
   aggregate each menu.

A missing/trashed recipe makes `calculation.complete=false`; monetary KPIs are
`null`. The manager sees the unavailable line and must remove/replace/restore it.
The kitchen sees the same availability marker, with no monetary diagnostics.

### Batched allergen rollup

Add/refactor a batch loader such as
`loadRecipeAllergensByIds(db, org, recipeIds, { includeTrashed: true })`, reusing
the Sprint 9 queries for recipe lines, ingredient tags, review state, and overrides.
Do not call `loadRecipeAllergenRollup` once per menu item.

`mergeMenuAllergens(rollups)` is pure: union by allergen, keep `maxPresence`, sort by
catalog order, and OR `hasUnreviewedIngredient`. Trashed-but-referenced recipes still
contribute allergens; unavailable never means allergen-free.

### Mutations

- `createMenu` / `updateMenu`: validate a non-empty distinct item set, lock the
  referenced active recipes `FOR UPDATE` in id-ascending order, then insert/replace
  items in the same transaction. Foreign, missing, or trashed ids return
  `invalid_recipe`. `updateMenu` locks and reasserts active menu state before
  replacing lines.
- `softDeleteMenu`, `restoreMenu`, `purgeMenu`: org-scoped; purge only a trashed
  menu and rely on item cascade.
- `countMenusUsingRecipe` / `purgeRecipeWithMenuGuard`: check the menu reference
  **before** unlinking transactions. Referenced → `in_menu`, with zero side effects.

All callers still use `withOrg`; explicit org predicates plus RLS remain the two
tenant boundaries.

---

## 4. Recipe trash/purge coupling

- Soft-deleting a recipe remains allowed. Menu item and recipe row remain; the menu
  becomes visibly incomplete. Restoring the recipe makes it available again.
- Manual recipe purge returns `RECIPE_IN_MENU` while any `menu_items` row references
  it. It must check this before nulling `transactions.recipe_id`.
- `purgeExpired` purges expired menus **first** (cascade frees their menu items),
  then builds one shared set of purgeable expired recipes excluding any remaining
  menu reference. Use that same candidate set both when unlinking transactions and
  deleting recipes, so a pinned recipe never loses transaction links accidentally.
- Extend `PurgeResult` with `menus`; update cron totals, audit metadata, JSON response,
  route tests, and existing assertions.
- Add menus to the manager-only Trash page/view/actions and all relevant cache
  revalidation paths.

This is a catalogue integrity rule, not an F3 historical-document snapshot.

---

## 5. Server actions, validation, audit, F4

### Actions — `app/(app)/menus/actions.ts`

`createMenuAction`, `updateMenuAction`, `deleteMenuAction`, plus manager-only Trash
restore/purge actions. Canonical order:

1. `isManager()` → `FORBIDDEN` before org lookup/data access;
2. Zod validation;
3. `withOrg` mutation + audit in the same transaction;
4. revalidate `/menus`, detail path, `/trash`, and dashboard/search consumers as
   applicable.

Kitchen has no menu mutation action. Do not accept a role-dependent payload and
silently preserve price: all mutations are manager-only.

### Validation — `lib/validation/menus.ts`

- name: trimmed `1..200`;
- selling price: integer cents `0..2_147_483_647`, nullable;
- notes: trimmed/null, max 1000;
- items: `1..100`;
- recipe id: non-empty;
- quantity: integer `1..1000`;
- reject duplicate recipe ids before data access.

### Errors and audit

- Add `MENU_RECIPE_INVALID` and `RECIPE_IN_MENU`; reuse `INVALID_INPUT`,
  `NOT_FOUND`, `FORBIDDEN`.
- Add `menu.create`, `menu.update`, `menu.delete` to `AuditAction`.
- `menu.update` metadata: `itemCount`, `priceChanged`, and changed field names only;
  never price values or notes. Generic Trash audit covers restore/purge.
- Every new error gets `actionErrors.*` i18n mapping.

### Read authorization

`/menus` and `/menus/[id]` branch on `getUserRole` before loading data:

| Surface | Kitchen | Manager |
| --- | --- | --- |
| Menu identity/notes | yes | yes |
| Composition/quantities/availability | yes | yes |
| Allergens/unreviewed warning | yes | yes |
| Selling price, costs, food-cost %, margin/light | key absent | yes |
| Mutations/Trash | forbidden | yes |

---

## 6. UI

- `/menus`: both roles see name, component count, availability and allergen chips.
  Manager additionally sees price/cost/food-cost/margin and New/Edit controls.
- `/menus/[id]`: manager editor with active-recipe picker, unique recipe rows,
  quantities, price and live KPIs. Kitchen receives a read-only operational view.
- Incomplete menu: prominent warning plus unavailable recipe rows. Manager KPI cards
  show `—`; never show a partial total or improved traffic light.
- Sidebar entry visible to both roles near Recipes.
- All strings use `menus.*`; include keyboard, focus, empty/error and responsive
  states. Allergen copy retains the existing operational/not-legal-declaration tone.

---

## 7. Search

- Add `'menu'` to `SearchEntityType`, `searchMenus` in `queries.ts`, and a registry
  descriptor with `canAccess: () => true`.
- Query active menus only, select name/id only, use the pg_trgm/ILIKE pattern, and
  deep-link `/menus/[id]`.
- Add `search.groups.menus` i18n and registry/query tests, including kitchen access
  and absence of monetary subtitles.

---

## 8. Tests

### Pure

- menu aggregation: complete, incomplete, duplicate defensive input, quantity,
  safe-integer overflow;
- food-cost: null/zero price → `null`, rounding, >100%;
- allergen merge: max presence, deterministic order, unreviewed propagation.

### PGlite/data

- create/update/reorder; duplicate recipe rejected; active same-org recipe required;
- derived cost reconciles with `recipeCost × quantity` and changes after an
  ingredient price change;
- trashed recipe remains a visible unavailable line; calculation/KPIs become null;
  restore makes it complete again;
- recipe purge is blocked with no transaction unlink; after removing the item or
  purging the menu it succeeds;
- expired menus purge before recipes; a surviving menu pins its recipe;
- allergen union includes trashed component recipes;
- soft-delete/restore/purge menu; cross-org RLS and composite-FK rejection;
- account export version 9, both tables, no foreign tenant.

### F4/RBAC

- every mutation returns `FORBIDDEN` for kitchen before data access;
- kitchen loader SQL/DTO contains none of the monetary keys and does not call cost
  helpers; manager DTO does;
- kitchen pages/search expose operational fields only;
- action responses and serialized props preserve key absence.

### Audit/cron/routes

- successful menu mutations audit exactly once in the same org; refused/no-op
  operations do not audit; metadata has no price value or notes;
- Trash route/action tests include menus and `RECIPE_IN_MENU`;
- cron response, counters and `cron.purge` metadata include `menus`.

---

## 9. Out of scope

Raw-ingredient/nested components; folders; menu PDF; photos; scheduling/seasonality;
packaging rules beyond component recipe cost; sales/menu references and popularity
engineering; snapshots; ledger movements; multi-currency conversion.

---

## 10. Definition of Done

- `npm run lint && npm run typecheck && npm test && npm run build` green.
- Migration `0028` generated, SQL/meta hand-reviewed, journal guard green, applied
  locally only; RLS verified under `tenant_app`.
- F4 proven by explicit kitchen queries and key-absent DTOs; all mutations forbidden
  to kitchen before data access.
- Cost derives from existing `recipeCost`; incomplete menus never report partial
  cost/margin as complete.
- Allergen union is batched, includes unavailable retained components, and propagates
  unreviewed state.
- Recipe purge never silently mutates a surviving menu and never performs partial
  unlink side effects when blocked.
- Menu mutations and Trash lifecycle audited as specified.
- Account export 8 → 9, search/nav/i18n/Trash/cron wiring and tests complete.
- `docs/sprint-10-menus-plan.md` committed; production migration requires a separate
  owner review/authorization.

---

## 11. Codebase anchors

- Cost/margin: `lib/calculations/recipeCost.ts`, `margin.ts`.
- F4 DTO precedent: `lib/data/recipes.ts` (`toKitchenRecipe*`) and
  `tests/f4-financial-rbac.test.ts`; Sprint 10 hardens this with explicit kitchen
  projections.
- Allergens: `lib/data/allergens.ts` batched loaders;
  `lib/calculations/allergens.ts` (`maxPresence`, catalog ordering).
- Recipe lifecycle: `lib/data/recipes.ts`; Trash ordering in `lib/data/trash.ts`;
  manager actions/page under `app/(app)/trash`; purge cron route.
- Search: `lib/search/types.ts`, `registry.ts`, `queries.ts`.
- Plumbing: `lib/db/schema.ts` + `businessTables`, `lib/db/rls.ts`,
  `lib/data/account-export.ts`, `lib/data/audit.ts`, `lib/action-result.ts`,
  `lib/i18n/messages/en.json`, `drizzle/meta/_journal.json`.

## Verification

1. Generate and inspect migration `0028`; run local migrate and confirm journal/RLS.
2. Run all tests, then lint/typecheck/build.
3. Manager: create menu with two recipes, verify live cost and KPIs; change an
   ingredient price and confirm recalculation; trash a component and confirm the menu
   becomes incomplete with no KPI; restore it and confirm recovery.
4. Attempt to purge the trashed component while referenced: receive
   `RECIPE_IN_MENU` with menu and transaction links unchanged. Remove the line, then
   purge successfully.
5. Kitchen: list/detail/search show composition, quantities, availability and
   allergens; browser payload contains no price/cost/margin keys; all mutations are
   `FORBIDDEN`.
6. Trash/cron: purge an expired menu, verify item cascade, counters/audit, and that a
   formerly pinned expired recipe can purge in the correct order.
