# Kitchen Scale module - senior implementation plan

> **Status: SENIOR-REVIEWED implementation plan - ready for dev.**
>
> This is a relocation and UX consolidation of existing recipe scaling, not a new
> accounting or production feature. Keep the implementation DB-inert: **no
> migration, no schema change, no new dependency, no new Server Action, no new
> print/PDF route**.

## 0. Senior verdict

Approved with the corrections below.

The original draft had the right product direction, but it was not implementation
safe enough in three places:

1. It said to "reuse" the recipe list query. In the current repo, `listRecipes`
   returns full recipe rows, and the recipes page strips money only for kitchen
   users. Kitchen Scale must be money-free for **both** roles by DTO type, so it
   needs a small operational listing shape instead of passing full manager rows.
2. It assumed component tests were already a local pattern. The repo's Vitest
   config runs in `node`, there is no React Testing Library dependency, and there
   are no existing `.test.tsx` component tests. Do not add a test dependency for
   this relocation. Test the pure workbench model and data boundaries instead.
3. It left the `?portions=` export contract a little too loose. The existing
   prep-card PDF returns `400` for invalid scale params; the print page falls back
   to unscaled. The workbench must build only valid links and must disable/hide
   export when the derived portions are outside `RECIPE_SCALE_PORTIONS_MAX`.

## 1. Current-code facts to preserve

| Topic | Verified source | Consequence |
| --- | --- | --- |
| Existing scale UI | `components/app/recipes/recipe-scale-panel.tsx` | Already supports portions, anchor ingredient, and yield-weight/preset basket. Port behavior; do not invent new math. |
| Pure scale math | `lib/calculations/recipeScale.ts` | Reuse `deriveScale`, `scaleLineQuantity`, `sumPresetBasketGrams`, and the overflow guard. |
| Scale query validation | `lib/validation/recipe-scale.ts` | Export links must use `?portions=<positive decimal>` with the existing max/precision rules. |
| Recipe detail load | `app/(app)/recipes/[id]/page.tsx` | Loads recipe, presets, folders, settings, and strips money for kitchen via `toKitchenRecipeWithIngredients`. |
| Operational prep card print | `app/(app)/recipes/[id]/prep-card/print/page.tsx` | Both roles can open it; invalid `?portions=` falls back to unscaled. |
| Operational prep card PDF | `app/api/recipes/[id]/prep-card/pdf/route.ts` | Both roles can download it; money-free by type, rate-limited, audited as `export.recipePrepCardPdf`, invalid `?portions=` returns `400`. |
| Financial cost sheet | `/recipes/[id]/card/print`, `/api/recipes/[id]/card/pdf` | Manager-only, money-bearing. Kitchen Scale must not link to these routes. |
| Recipe folders | `lib/data/recipe-folders.ts` | Folder listing/counts exist and are org-scoped. Use them only as lightweight filters, not as a Wibox-style folder landing in MVP. |
| Unit display | `lib/units/index.ts` | Use `displayUnitsFor`, `pickDisplayUnit`, `formatQuantity`, `fromCanonical`, and `toCanonical`; do not display raw grams with ad-hoc formatting. |
| Test setup | `vitest.config.ts` | Tests run in `node`; no component-test dependency is present. Prefer pure helper/data/route tests. |

## 2. Locked decisions

1. **Remove all scale usage from the recipe editor.** The full
   `RecipeScalePanel` leaves the editor: portions, anchor ingredient, preset
   basket, and export buttons. One operational scaling surface is easier to teach
   and safer to maintain.
2. **Keep preset management in the recipe editor.** `RecipePresets` remains there
   unchanged. Presets are recipe metadata curated on the recipe page; Kitchen Scale
   consumes them only.
3. **Do not touch `recipe_presets` persistence.** No schema change, migration, or
   preset Server Action change is needed.
4. **Scaling remains ephemeral.** Nothing writes scaled quantities, scale factors,
   sessions, or target batches to the database.
5. **Both roles can use `/kitchen-scale`.** It is operational and money-free. No
   `NoAccess` gate, no euro/dollar text, no cost/kg, no margin, no manager-only
   preview in MVP.
6. **Print/download reuse the existing operational prep-card routes.** The
   workbench converts the current scale factor to equivalent portions:
   `derivedPortions = factor * recipe.yieldPortions`, then links to:
   - `/recipes/[id]/prep-card/print?portions=<derivedPortions>`
   - `/api/recipes/[id]/prep-card/pdf?portions=<derivedPortions>`
7. **No new routes for documents.** Do not create another PDF/print renderer.
8. **No entitlement gate.** Scaling was free inside recipes; moving it must not
   introduce a paywall.
9. **No Wibox folder-card landing in MVP.** Ship searchable recipes plus an
   optional folder filter. Folder cards, recipe preview modal, saved sessions, and
   manager cost preview are Phase 2.

## 3. Data contract

Kitchen Scale needs a read-only, money-free listing DTO for **both** roles.

Add a small data helper, preferably near the existing recipe data helpers:

```ts
export type KitchenScaleRecipeListItem = {
  id: string;
  name: string;
  folderId: string | null;
  yieldPortions: number;
  yieldWeightGrams: number | null;
  lineCount: number;
  presetCount: number;
};
```

Implementation rules:

- Run inside `withOrg(organizationId, ...)`.
- Filter `recipes.organizationId = organizationId` and `recipes.deletedAt IS NULL`.
- Return only the fields above. Do not return full `Recipe` rows to the client.
- Count active recipe lines and presets server-side. If the SQL aggregation becomes
  noisy, two or three simple org-scoped queries grouped in memory are acceptable;
  this page is read-only and MVP-sized.
- Do not include `laborCostCents`, `energyCostCents`, `packagingCostCents`,
  `sellingPriceCents`, ingredient `priceCents`, batch totals, or any derived money
  field.

For the scale detail page, load:

- `getRecipeWithIngredients(tx, organizationId, recipeId)`
- `listRecipePresets(tx, organizationId, recipeId)`
- `getOrgSettingsRow(tx, organizationId)` or `getOrgSettings()`

Then always pass `toKitchenRecipeWithIngredients(data)` to the client, even for
managers. Kitchen Scale is not a financial surface.

## 4. Route and component shape

Add:

```text
app/(app)/kitchen-scale/page.tsx
app/(app)/kitchen-scale/[recipeId]/page.tsx
components/app/kitchen-scale/recipe-list.tsx
components/app/kitchen-scale/scale-workbench.tsx
components/app/kitchen-scale/scale-workbench-model.ts
```

`scale-workbench-model.ts` is deliberately pure so the important behavior can be
tested without adding React Testing Library or changing the Vitest environment.

### 4.1 `/kitchen-scale`

Server component:

- Derive `organizationId` with `getOrgId()`.
- Load `KitchenScaleRecipeListItem[]` inside `withOrg`.
- Load folders via `listFoldersWithCounts` if the folder filter is included.
- Render a compact operational page header and `recipe-list`.

Client list:

- Search by recipe name with simple `includes` matching.
- Optional folder filter with "All" and "No folder" entries.
- Card content: recipe name, folder badge, line count, preset count, base portions,
  and base yield weight when present.
- Card click navigates to `/kitchen-scale/[recipeId]`.
- No create, delete, move-folder, import, or edit controls on this page. Those stay
  on `/recipes`.

### 4.2 `/kitchen-scale/[recipeId]`

Server component:

- Derive `organizationId` with `getOrgId()`.
- Load recipe + presets inside `withOrg`.
- `notFound()` when the recipe is missing, trashed, or cross-org.
- Map with `toKitchenRecipeWithIngredients` before sending props.
- Pass `measurementSystem` from org settings, falling back to
  `DEFAULT_ORG_SETTINGS`.

Client workbench:

- Left side:
  - one numeric quantity input per preset;
  - one custom target-weight input with a unit select from
    `displayUnitsFor('weight', measurementSystem)`;
  - running total from `sumPresetBasketGrams`;
  - Calculate/Reset controls.
- Right side:
  - scaled ingredient table using `scaleLineQuantity`;
  - quantities displayed with `formatQuantity(quantity, dimension,
    measurementSystem)`;
  - click/edit on any ingredient quantity to re-anchor the whole scale.
- Empty presets:
  - show a short "no presets, use custom weight" state;
  - custom weight still works.
- Error states:
  - surface `invalid_target`, `invalid_anchor`, `invalid_yield`,
    `invalid_factor`, and `overflow` through `kitchenScale.errors.*`;
  - never silently clamp or coerce an invalid target into a valid one.

## 5. Workbench model contract

The pure model should expose small functions that the component calls:

```ts
type BasketInput = {
  presetQuantities: Array<{ targetWeightGrams: number; quantity: number }>;
  customWeightGrams: number;
};

type ScaledLine = {
  id: string;
  ingredientId: string;
  name: string;
  dimension: Dimension;
  quantity: number;
};
```

Required behavior:

- `basketTargetGrams(input)` delegates to `sumPresetBasketGrams`.
- `scaleFromBasket(recipe, lines, basket)` calls `deriveScale` with
  `{ kind: 'yieldWeight', baseWeightGrams, targetWeightGrams }`.
- `scaleFromAnchor(recipe, lines, anchorLineId, targetCanonical)` calls
  `deriveScale` with `{ kind: 'anchor', anchorLineQuantity, targetCanonical }`.
- `scaledLines(lines, factor)` maps through `scaleLineQuantity`.
- `portionsParamFor(scale)` returns a string suitable for `?portions=` only when
  `scale.ok`, `scaledPortions > 0`, `scaledPortions <= RECIPE_SCALE_PORTIONS_MAX`,
  and the value satisfies the existing four-decimal URL precision contract.

Do not duplicate the core arithmetic in the component. The component owns input
text, focus, selection, and layout; the model owns the deterministic scale result.

## 6. Print/download contract

The workbench may show Print and Download PDF only when it has a valid
`portionsParamFor(scale)` value.

Rules:

- Use the operational prep-card routes only.
- Do not link to `/recipes/[id]/card/print` or `/api/recipes/[id]/card/pdf`.
- For the print page, pass the valid `?portions=` param. If the link is somehow
  edited by hand to an invalid value, the existing print page falls back to the
  unscaled card.
- For PDF, pass the same valid `?portions=` param. If edited by hand to an invalid
  value, the existing API route returns `400`.
- Because Kitchen Scale does not edit recipes, there is no dirty-state mismatch:
  the saved recipe is the only source of truth.

## 7. Remove scale from the recipe editor

After the new page and workbench exist:

- Remove the `RecipeScalePanel` import and mount from
  `components/app/recipes/recipe-editor.tsx`.
- Delete state/commentary that exists only to keep the scale panel in sync, such as
  scale-only preset synchronization comments and export dirty gating, but keep any
  state still needed by `RecipePresets`.
- Keep `RecipePresets` mounted and functional.
- Delete `components/app/recipes/recipe-scale-panel.tsx` only after its behavior is
  ported or intentionally dropped.
- Keep `lib/calculations/recipeScale.ts`, `lib/validation/recipe-scale.ts`, and
  all prep-card routes untouched unless tests expose a real bug.
- Move or recreate user-visible copy under `kitchenScale.*`, then delete
  `recipes.scale.*` keys only after `rg "recipes.scale|RecipeScalePanel"` shows no
  remaining usage.

## 8. Navigation and i18n

Navigation:

- `lib/nav.ts`: add `{ key: 'kitchenScale', href: '/kitchen-scale' }` in the
  `operations` group immediately after `recipes`.
- `components/app/sidebar.tsx`: import `Scale` from `lucide-react` and add
  `kitchenScale: Scale` to the icon map.
- `lib/i18n/messages/en.json`: add `nav.kitchenScale`.

New `kitchenScale` i18n namespace should cover:

- page title/subtitle;
- search placeholder;
- folder filter labels;
- recipe empty state;
- card labels for lines, presets, portions, and yield weight;
- basket labels for preset quantity, custom weight, total target weight,
  calculate, reset;
- scaled table headers;
- click-to-edit/re-anchor copy;
- print/download labels;
- errors matching every `RecipeScaleResult` failure reason.

No hardcoded user-visible strings, no emoji, no Wibox orange gradients.

## 9. Test plan

Keep the test plan aligned with the current stack. Do not add a DOM testing
dependency for this module.

### Pure math

Existing `lib/calculations/recipeScale.test.ts` should continue passing. Add only
if a missing case is discovered.

### Pure Kitchen Scale model

Add `components/app/kitchen-scale/scale-workbench-model.test.ts` or a nearby
`lib` test if the model is placed under `lib`.

Cover:

- preset basket `2 x 500g + 1 x 300g` produces `1300g`;
- custom weight only;
- preset basket plus custom weight;
- yield-weight scale gives `factor = targetWeightGrams / yieldWeightGrams`;
- anchor edit recalculates factor from the edited ingredient quantity;
- invalid/zero input returns no exportable portions param;
- overflow reason propagates from `deriveScale`;
- generated `portions` param obeys the existing max and decimal precision.

### Data boundary

Add a focused data test for the new listing helper:

- only active recipes in the current org are returned;
- trashed and cross-org recipes are absent;
- DTO keys are exactly operational: no recipe money fields and no ingredient
  `priceCents`;
- `lineCount` and `presetCount` are correct.

### Page/route regression

- Existing `tests/recipe-prep-card-route.test.ts` remains the authority for PDF
  route behavior.
- Add a light regression that Kitchen Scale detail maps through
  `toKitchenRecipeWithIngredients` before props are sent, or cover the same
  guarantee through the data/model boundary if direct page tests are awkward.
- Add an editor regression at the cheapest available layer: `rg`/typecheck should
  prove no `RecipeScalePanel` import remains, and existing recipe/preset tests must
  still pass.

### Manual QA

- Manager and kitchen can open `/kitchen-scale`.
- No money text appears anywhere on the page for either role.
- Metric and imperial unit display are reasonable.
- Print and PDF open the existing prep-card surfaces with the derived scale.
- Mobile layout does not require horizontal scrolling for the basket or ingredient
  table.

## 10. Commit slices

1. `feat(kitchen-scale): add operational recipe picker`
   - route, nav entry, i18n namespace, money-free listing DTO, search/folder filter.
2. `feat(kitchen-scale): add scale workbench`
   - detail route, pure workbench model, basket/custom-weight flow, re-anchor edit,
     prep-card links, tests.
3. `refactor(recipes): move scaling out of editor`
   - unmount/delete `RecipeScalePanel`, prune dead state and i18n, preserve
     `RecipePresets`, run regression tests.

This order keeps scaling available throughout the work.

## 11. Definition of done

- `/kitchen-scale` is available to both roles.
- The page is money-free by DTO type for managers and kitchen users.
- Recipe editor no longer renders scale usage.
- Recipe preset management remains on the recipe editor and still works.
- No migration, schema diff, dependency, Server Action, PDF route, or print route
  is added.
- Existing operational prep-card print/PDF works from Kitchen Scale using the
  derived `?portions=`.
- No references to `RecipeScalePanel` or `recipes.scale.*` remain after removal.
- Gates green:

```text
npm run lint
npm run typecheck
npm test
npm run build
```

Do not update `PLANO.md` as part of this plan review. It already records recipe
scaling as done; any product/backlog wording for Kitchen Scale should be updated
only in the implementation PR if the owner asks for it.

## 12. Explicit non-goals

- No persisted scale sessions.
- No duplicate-as-scaled-recipe.
- No inventory reservation, stock shortfall, production posting, or movement
  ledger write.
- No manager cost preview on Kitchen Scale MVP.
- No kitchen access to financial cost sheets.
- No new PDF layout.
- No Wibox folder-card landing, language switcher, or recipe preview modal.
