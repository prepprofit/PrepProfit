# Sprint F4 — RBAC financial lockdown (kitchen sees no money) — implementation plan

> **Status:** **AUTHORIZED (owner review 2026-06-21)** — the §5 decisions are
> resolved and the dev's hardening additions are folded in (§2g, §2h, §5, §6). F4 is
> the owner's locked decisions #1 + #2 (see `[[expansion-plan-kitchen-ops]]`).
> F1/F2/F3 are done + on `main`. Build in one slice, full diff review at the end —
> **no commit/merge/prod until the diff is reviewed** (no migration in F4). Source
> spec: `docs/expansion-plan-kitchen-ops.md` §4 F4.
>
> **Authorization is conditional on every item in §2g + §2h + §6 being delivered.**
> The dev was explicit: with these incorporated it's authorized; without them, not.

---

## 0. What F4 is (and why it's a security change, not cosmetics)

Today the **recipes**, **ingredients**, and **recipe-card** surfaces expose
**money** (ingredient cost prices, recipe cost breakdown, per-portion cost, selling
price, margin) to **every** role, including `kitchen`. The owner's locked decisions
reverse that:

1. **View lockdown.** Kitchen sees **operational content only** — ingredient names,
   quantities, units, dimensions, yield, steps/notes, stock, (future) allergens —
   and **no money anywhere**.
2. **No price editing.** Kitchen **cannot** create or change a price/cost (price
   edits are financial → manager-only, refused server-side before any write).

The critical point: **CLAUDE.md "Authorization" says "UI hiding is never enough."**
Money currently reaches the kitchen client as serialized props from the server data
loaders (`listIngredients` returns full `Ingredient` rows incl. `priceCents`;
`getRecipeWithIngredients` returns each line's `ingredient.priceCents` plus the
recipe's `laborCostCents` / `energyCostCents` / `packagingCostCents` /
`sellingPriceCents`). Hiding a column in a client component still ships the number
in the HTML/props/network. **F4 must remove money from the server payload for
kitchen**, then hide the now-absent fields in the UI, then add server-side write
refusals — and prove all three with tests. This mirrors how financials were locked
(`canAccessFinancials` → `NoAccess` page + `FORBIDDEN` action + sidebar hide).

What's already done (do NOT redo):
- `updateIngredientAction` **already** refuses a price change from a non-manager
  (`app/(app)/ingredients/actions.ts:78` — `priceChanged && !manager → 'forbidden'`,
  Sprint F2). F4 keeps it and adds the **create** path + the UI + tests.
- Financials/invoices/payroll/break-even/dashboard are **already** manager-only
  (incl. the dashboard redirect), so kitchen never sees those money surfaces. F4
  does **not** touch them.

---

## 1. The RBAC rule F4 codifies

A single predicate decides money visibility, kept pure + unit-testable next to
`canAccessFinancials` in `lib/auth.ts`:

```ts
/** Recipe/ingredient COST & PRICE are financial — managers only. Kitchen sees the
 *  operational recipe (names, quantities, yield, steps) but never money. */
export function canSeeRecipeCosts(role: UserRole): boolean {
  return role === 'manager';
}
```

(Name open to bikeshedding — see §5. It's deliberately the same shape as
`canAccessFinancials` so the pattern is familiar.)

The rule applies on **three layers**, in this order (defense in depth):

1. **Data layer** — kitchen loaders omit/zero money fields (the payload never
   contains a cost).
2. **UI layer** — money columns/cards/buttons are not rendered for kitchen.
3. **Action/route layer** — any write that sets a price/cost refuses a non-manager
   **before** touching data (`FORBIDDEN` / HTTP 403/402 as appropriate).

---

## 2. What F4 ships (surface by surface)

### 2a. Ingredients (`/ingredients`)
- **Data:** introduce a role-aware shape. For kitchen, the page must NOT pass
  `priceCents` (nor `pendingPriceCents`) into `IngredientGrid`. Cleanest: a
  `listIngredientsForRole(...)` / a `toKitchenIngredient()` projection in
  `lib/data/ingredients.ts` that drops the money columns, returning a typed
  `KitchenIngredient` (no `priceCents`). The page picks the loader by role.
- **UI (`components/app/ingredients/ingredient-grid.tsx`):** when kitchen, render
  the grid **without** the Price column (and without the price input in the
  "add new" row). The `needsPricing` badge stays (operational signal). Name,
  dimension, supplier, delete stay editable (still allowed for kitchen — see §5.4
  for whether kitchen may even create/edit ingredients at all).
- **Actions (`app/(app)/ingredients/actions.ts`):**
  - `updateIngredientAction` — keep the F2 manager-gate (already there).
  - `createIngredientAction` — **NEW gate**: a non-manager creating with
    `priceCents > 0` must be refused (today the comment says "Create-with-price RBAC
    is completed in F4"). Decision in §5.4: refuse (`FORBIDDEN`) vs. silently coerce
    to `priceCents: 0, needsPricing: true`. Recommended: **coerce to 0 + needsPricing
    for kitchen** so kitchen can still add an operational ingredient, and a manager
    prices it later — but only if §5.4 says kitchen may create ingredients at all.

### 2b. Recipes editor (`/recipes/[id]`)
This is the largest surface. The editor (`components/app/recipes/recipe-editor.tsx`)
currently shows, for everyone: a per-line **Cost** column, the **Cost** card
(ingredient/hidden/total/per-portion), the **Pricing** card (selling price input +
margin badge + suggested price), and the **labor/energy/packaging** cost inputs in
the Parameters card.
- **Data (`app/(app)/recipes/[id]/page.tsx` + `lib/data/recipes.ts`):** for kitchen,
  `getRecipeWithIngredients` must return lines **without** `ingredient.priceCents`
  and a recipe **without** the four money fields (or zeroed). Add a role-aware
  loader / projection (`getRecipeForRole`) returning a `KitchenRecipeView`.
- **UI:** for kitchen, the editor renders only the operational parts — recipe name,
  folder, yield portions, yield %, the ingredient table's **name + quantity + unit**
  (no Cost column), and notes. It does **not** render the Cost card, the Pricing
  card, the labor/energy/packaging inputs, the "Cost sheet" button (§2d), or the
  suggested-price control.
- **Actions (`app/(app)/recipes/actions.ts`):**
  - `updateRecipeAction` — **NEW gate**: money fields (`laborCostCents`,
    `energyCostCents`, `packagingCostCents`, `sellingPriceCents`) must not be
    settable by kitchen. Because kitchen still edits operational fields
    (name/yield/notes/folder), the action must **preserve the stored money values**
    for a kitchen caller (load current, overwrite the 4 money fields with the
    existing DB values) — or refuse if any differs. Recommended: **preserve stored
    values** (kitchen edits are non-financial, so silently keep money intact)
    rather than `FORBIDDEN` (which would block a legitimate name/yield edit).
  - `addRecipeIngredientAction` / `updateRecipeIngredientAction` /
    `removeRecipeIngredientAction` — these carry **no money** (quantity only), so
    they stay open to kitchen unchanged. Adding an ingredient line to a recipe is
    operational. ✅ no change.

### 2c. Inventory (`/inventory`)
- Appears **already money-free**: `app/(app)/inventory/page.tsx` passes only
  `ingredients` + `measurementSystem` (no `currency`) to `InventoryPanel`. **Action:
  verify** `components/app/inventory/inventory-panel.tsx` renders no cost/price, then
  ensure the kitchen ingredient payload (§2a) is reused so `priceCents` isn't shipped
  here either. Likely a no-op + a guard test.

### 2d. Recipe card / cost sheet — **DECISION REQUIRED (§5.1)**
`app/(app)/recipes/[id]/card/print/page.tsx` and
`app/api/recipes/[id]/card/pdf/route.ts` render a **cost sheet**: per-line cost,
ingredient/labor/energy/packaging totals, total cost, cost per portion, selling
price, margin (`lib/documents/recipe-card-data.ts` → `RecipeCardDocumentData`). Its
header comment literally says *"NOT manager-only — the recipe editor already shows
kitchen the same cost + margin."* **F4 invalidates that premise.** Options in §5.1.
Recommended: make the cost-sheet **manager-only** (page → `NoAccess` + route → 403
for kitchen, hide the editor's "Cost sheet" button for kitchen), and defer an
operational-only "kitchen recipe card" (no money) to a later sprint if wanted.

### 2e. Navigation / search
- **Sidebar (`components/app/sidebar.tsx`):** Recipes/Ingredients/Inventory stay
  visible to kitchen (they remain operational). No nav change expected — **verify**.
- **⌘K search (`lib/search/registry.ts`):** recipe + ingredient descriptors return
  **names only** (no money) and are correctly role-open already. Deep-links land on
  the money-stripped editor/grid. **Verify** no money in search results; expected
  no change.

### 2f. Release note
A short `docs/` release note (or an entry the dev wants) documenting the **behavior
change**: kitchen no longer sees recipe/ingredient cost, margin, or selling price,
and cannot price ingredients. The owner asked for this to be an explicit, tracked
change — not silent.

### 2g. Hardening additions (owner/dev review — MANDATORY)
The first draft only covered the obvious read surfaces. The dev found four more
leak/forge paths; F4 is authorized **only** with all of these closed:

1. **`/recipes` listing needs a DTO too.** `listRecipes` returns full `Recipe[]`
   (incl. `laborCostCents` / `energyCostCents` / `packagingCostCents` /
   `sellingPriceCents`) and `app/(app)/recipes/page.tsx` passes them straight into
   the `RecipeList` client component. The cards only *show* name + portions, but the
   money is in the serialized props. → add a role-aware list projection
   (`RecipeListItemView` for kitchen with no money) and have the page pick it by role.
2. **`createRecipeAction` must block/coerce ALL financial fields.** Today it inserts
   `parsed.data` verbatim, so a kitchen user can **forge** `sellingPriceCents` /
   labor / energy / packaging on create. → for a non-manager, force all four money
   fields to `0` / `null` server-side before insert (operational create only),
   regardless of what the client sent.
3. **Server Action RESPONSES must use the kitchen DTO.** `createIngredientAction`,
   `updateIngredientAction`, `createRecipeAction`, `updateRecipeAction` currently
   `return { data: <full row> }` — that round-trips `priceCents` / recipe money back
   to the kitchen client. → these actions must return the **role-appropriate DTO**
   (no money for kitchen). The client state-reconciliation (e.g. the ingredient
   grid's `setRows`/`draftFromRow`) must consume the kitchen DTO type, so a stripped
   response can't reintroduce a money field.
4. **All editor data sources filtered, plus inventory.** The recipe editor page
   loads **two** money-bearing sources — the recipe (`getRecipeWithIngredients`,
   recipe money + per-line `ingredient.priceCents`) **and** the ingredient picker
   list (`listIngredients`, full `priceCents`). **Both** must be role-filtered for
   kitchen. `/inventory` reuses the same kitchen ingredient projection (§2c).

### 2h. Operational write paths + the `dimension` decision (owner/dev review)
1. **Kitchen-specific operational Zod schemas — kitchen must never be forced to
   re-send a hidden price.** A kitchen edit of name / yield / supplier / notes /
   quantity must validate against a schema that **does not include** the money
   fields, so the client genuinely never holds or transmits a price. Add
   `kitchenRecipeSchema` / `kitchenIngredientSchema` (operational subsets) in
   `lib/validation/`. The action picks the schema by role; for a manager the full
   schema still applies. This also means `updateRecipeAction`/`updateIngredientAction`
   for kitchen **merge onto the stored row server-side** (load current, keep its
   money columns untouched) rather than expecting the client to echo them.
2. **`dimension` change is price-significant — gate it.** Changing an ingredient's
   `dimension` (kg ↔ l ↔ piece) re-bases what `priceCents` *means* (per kg vs per
   litre vs per piece), so an unguarded dimension edit is an indirect price mutation.
   Decision (owner): **kitchen may choose `dimension` when CREATING a price-less
   ingredient** (`priceCents: 0`, `needsPricing: true`), but **changing the
   `dimension` of an already-priced ingredient** (`priceCents > 0`) is
   **manager-only** — refuse a non-manager (`FORBIDDEN`) before the write, in the
   same locked transaction that already guards the price change
   (`app/(app)/ingredients/actions.ts`, reuse the `lockActiveIngredientRow` +
   manager check). A kitchen dimension edit on a price-less row stays allowed.

---

## 3. Files (anticipated)

### CHANGE
- `lib/auth.ts` — add `canSeeRecipeCosts(role)` (+ export).
- `lib/data/ingredients.ts` — kitchen projection / `KitchenIngredient` type (no
  `priceCents`/`pendingPriceCents`).
- `lib/data/recipes.ts` — kitchen projections: `KitchenRecipeView`
  (`getRecipeWithIngredients`, no recipe money + no per-line `ingredient.priceCents`)
  **and** `KitchenRecipeListItem` (`listRecipes`, no money) — §2g.1/§2g.4.
- `lib/validation/recipes.ts` — `kitchenRecipeSchema` (operational subset) — §2h.1.
- `lib/validation/ingredients.ts` — `kitchenIngredientSchema` (operational subset,
  no price) — §2h.1.
- `app/(app)/recipes/page.tsx` — pick the list loader by role (§2g.1).
- `app/(app)/ingredients/page.tsx` — pick loader by role; pass `canSeeRecipeCosts`.
- `app/(app)/recipes/[id]/page.tsx` — pick BOTH loaders (recipe + ingredient picker)
  by role (§2g.4); pass `canSeeRecipeCosts`.
- `app/(app)/inventory/page.tsx` — reuse the kitchen ingredient projection (§2c).
- `components/app/recipes/recipe-list.tsx` — accept the role DTO (no money type).
- `components/app/ingredients/ingredient-grid.tsx` — conditional Price column/input;
  consume the kitchen DTO in `setRows`/`draftFromRow` (§2g.3).
- `components/app/recipes/recipe-editor.tsx` — conditional cost/pricing UI; hide the
  "Cost sheet" button for kitchen (§5.1).
- `app/(app)/ingredients/actions.ts` — `createIngredientAction` forces `priceCents:0`
  + `needsPricing:true` for kitchen (§5.4); both actions return the role DTO (§2g.3);
  dimension-change-on-priced-row gate (§2h.2).
- `app/(app)/recipes/actions.ts` — `createRecipeAction` zeroes money for kitchen
  (§2g.2); `updateRecipeAction` kitchen-schema merge onto stored row (§5.3); both
  return the role DTO (§2g.3).
- `app/(app)/recipes/[id]/card/print/page.tsx` + `app/api/recipes/[id]/card/pdf/route.ts`
  — manager-only gate (§5.1).
- i18n message catalogs — release-note copy + the cost-sheet `NoAccess` body.

### CREATE
- Tests (see §6).
- `docs/` release note (§2f).

### NO migration, NO schema change. F4 is RBAC + payload shaping + UI + tests.

---

## 4. Do NOT duplicate / do NOT touch
- `updateIngredientAction`'s manager price-gate already exists (F2) — keep, don't
  rebuild.
- Financials / transactions / invoices / payroll / break-even / dashboard are
  already manager-only — out of scope.
- Recipe-line quantity actions carry no money — leave open to kitchen.
- The `priceCents` storage semantics (per kg/l/piece), price history, and accept-cost
  flow (F2) are unchanged.

---

## 5. Decisions — RESOLVED (owner review 2026-06-21)

1. **Recipe cost sheet (recipe card PDF/print) → MANAGER-ONLY.** Gate the print page
   (`NoAccess`) + the PDF route (403) and hide the editor's "Cost sheet" button for
   kitchen. No operational kitchen card in F4 (can be a later sprint if wanted).
2. **Money-stripping → OMIT via typed kitchen DTOs, never zero.** Kitchen types
   literally have no `priceCents` / recipe-money keys, so a `0` can't be mistaken for
   "free" and a stray field can't slip back through.
3. **`updateRecipeAction` for kitchen → edits ONLY operational fields.** The kitchen
   write path must **not receive nor re-send money**; the server merges the
   operational fields onto the stored row and leaves the money columns untouched
   (via the kitchen schema in §2h.1). Not a `FORBIDDEN` on the whole edit.
4. **Kitchen may create/edit ingredients WITHOUT price.** On create, the server sets
   `priceCents: 0` and `needsPricing: true` (ignores any client-sent price). On
   update, the F2 manager price-gate stays; non-price operational edits are allowed.
5. **Predicate name → `canSeeRecipeCosts` APPROVED.**
6. **Allergens → no implementation in F4; only do not block** a future allergen
   feature. No work now.

Extra points locked by this review (all MANDATORY — see §2g/§2h):
- `/recipes` listing gets a kitchen DTO (no money in the list payload).
- `createRecipeAction` forces all four recipe money fields to `0`/`null` for kitchen
  (no forging on create).
- create/update Ingredient **and** create/update Recipe actions return the
  role-appropriate DTO (responses carry no money for kitchen).
- both recipe-editor data sources (recipe + ingredient picker) and `/inventory` are
  role-filtered.
- kitchen-only operational Zod schemas so kitchen never holds/echoes a price.
- changing `dimension` of an already-priced ingredient is manager-only.

---

## 6. Tests (the proof — RBAC proven server-side, payloads AND forged writes)
- **`lib/auth.test.ts`** — `canSeeRecipeCosts('manager') === true`, `=== false` for
  `'kitchen'` (pure, like the existing `canAccessFinancials` test).
- **Payload key-absence tests (MANDATORY — §2g).** Assert the financial **keys
  themselves are absent** from every kitchen payload, not just hidden in the UI:
  - kitchen `listIngredients` projection → `'priceCents' in row === false` (and
    `pendingPriceCents`).
  - kitchen `getRecipeWithIngredients` projection → recipe has no `laborCostCents` /
    `energyCostCents` / `packagingCostCents` / `sellingPriceCents`; no line has
    `ingredient.priceCents`.
  - kitchen `listRecipes` projection → no money keys (§2g.1).
  - the **action responses** for kitchen create/update (ingredient + recipe) carry no
    money keys (§2g.3).
- **Forged-request / write-path tests (MANDATORY — §2g/§2h).** Drive the actions as
  kitchen with money in the input and prove it cannot land:
  - `createIngredientAction` with a price → row persisted with `priceCents: 0`,
    `needsPricing: true`, no price-history row; manager → priced + history written.
  - `updateIngredientAction` price change → `FORBIDDEN` (regression-guard F2).
  - **`createRecipeAction` forging** `sellingPriceCents`/labor/energy/packaging →
    persisted as `0`/`null`; manager → values honored.
  - `updateRecipeAction` as kitchen → operational edit (name/yield/notes) saves while
    the stored money columns are unchanged; money in the input is ignored.
  - **`dimension` change on a priced ingredient** as kitchen → `FORBIDDEN`; on a
    price-less ingredient → allowed; manager → allowed either way (§2h.2).
  - recipe-card PDF route → **403** for kitchen, **200** for manager; print page →
    `NoAccess` for kitchen (§5.1).
- **No new behavioral DB invariant / no migration** — RBAC + projection tests; PGlite
  where a round-trip is needed, pure otherwise.

Mock role via the existing test seam used by the financials/entitlement tests (the
`@/lib/auth` mock — see `tests/entitlement-enforcement.test.ts` / the route tests).

---

## 7. Definition of Done
- `npm run lint && npm run typecheck && npm test && npm run build` green.
- **Every kitchen payload — page props AND server-action responses — provably omits
  the financial keys** (`priceCents`, `pendingPriceCents`, recipe money), proven by
  key-absence tests (§6), not just hidden in the UI. Covers `listIngredients`,
  `getRecipeWithIngredients`, `listRecipes`, and the create/update action responses.
- Both recipe-editor data sources + `/inventory` role-filtered (§2g.4 / §2c).
- Kitchen UI shows no money on recipes/ingredients/inventory; manager unchanged.
- **Forged kitchen writes can't introduce money**: `createRecipeAction` /
  `createIngredientAction` coerce, `updateRecipeAction` ignores money, price + the
  priced-row `dimension` change are `FORBIDDEN` (§6 forged-request tests).
- Kitchen never has to re-send a hidden price (operational Zod schemas, §2h.1).
- Recipe cost sheet manager-only (§5.1).
- Release note committed (§2f).
- No schema, no migration.
- **Full diff handed to the dev before F5 is authorized.** F5/F6 stay unauthorized.

---

## 8. Out of scope for F4 (do NOT build)
- Any new money feature, tax, or sales (F5).
- Suppliers / PO / counters (F6 + Sprint 7/8).
- The operational "kitchen recipe card" unless §5.1 picks (b).
- Allergen data model (later sprint) — F4 only avoids blocking it.
- Custom Clerk roles — role stays `org:admin → manager`, else `kitchen` (`lib/auth.ts`).

---

## 9. Codebase anchors (verified this review)
- `lib/auth.ts:58` `getUserRole`, `:89` `canAccessFinancials` (the pattern to copy).
- `app/(app)/ingredients/actions.ts:78` — existing kitchen price-gate (F2); `:45` —
  the `createIngredientAction` "completed in F4" TODO.
- `app/(app)/recipes/actions.ts:65` `updateRecipeAction` (no money gate yet).
- `components/app/recipes/recipe-editor.tsx` — Cost col `:477`, Cost card `:642`,
  Pricing card `:659`, labor/energy/packaging inputs `:615-638`.
- `components/app/ingredients/ingredient-grid.tsx:277` — the Price column.
- `lib/data/recipes.ts` `getRecipeWithIngredients` / `lib/data/ingredients.ts`
  `listIngredients` — the loaders that currently ship money to every role.
- `app/(app)/recipes/[id]/card/print/page.tsx` + `app/api/recipes/[id]/card/pdf/route.ts`
  + `lib/documents/recipe-card-data.ts` — the cost sheet (§5.1).
- Test seam: `tests/entitlement-enforcement.test.ts`, the invoice/P&L route tests
  (`@/lib/auth` / `@/lib/entitlements` mock for role).
