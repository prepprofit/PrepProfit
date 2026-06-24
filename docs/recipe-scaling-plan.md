# Recipe scaling - senior implementation plan

> **Status: SENIOR-REVIEWED implementation plan - ready for dev.**
> Backlog item: `PLANO.md` -> Backlog -> "Recipe scaling/batch planning".
>
> This MVP is **DB-inert**: no migration, no schema change, no stored scale factor,
> no new dependency. Scaling is a derive-on-read/live-client view over the existing
> recipe model. The current codebase is the source of truth: since Sprint F4, the
> existing recipe **cost sheet** is manager-only (`canSeeRecipeCosts`), even though
> older `PLANO.md` text still says kitchen-allowed.

## 0. Outcome and non-negotiable boundaries

Recipe scaling lets a cook resize an existing recipe to a different batch size and
read the recalculated ingredient list live. It answers: "I need to make more/less
of this recipe."

Boundaries:

1. **Ephemeral only.** Scaling writes nothing to the database. There is no migration,
   new table, new column, or persisted factor. The panel keeps scale state in the
   client. Export routes derive scale from a query parameter.
2. **Operational first.** Scaled quantities are visible to both roles. Money remains
   manager-only everywhere.
3. **Existing cost sheet remains manager-only.** Do not make
   `/recipes/[id]/card/print` or `/api/recipes/[id]/card/pdf` kitchen-visible. Those
   surfaces are financial cost sheets in the current code and tests.
4. **If kitchen needs print/download in MVP, build an operational prep card.** It must
   contain recipe name, scaled portions, usable yield, ingredient quantities, and
   notes only. No cost column, no totals, no prices, no margins, and no hidden money
   keys in its view-model.
5. **Unit economics are invariant under scaling.** For managers, scaled batch cost is
   original batch cost times the scale factor. Cost per portion, selling price per
   portion, and margin do not change.
6. **Not production planning.** This feature never posts a batch, checks shortfall,
   reserves stock, or writes inventory movements. Production planning remains in
   `lib/calculations/production.ts` and `lib/data/productions.ts`.
7. **Reject invalid input.** Do not silently clamp, truncate, or coerce bad scale
   inputs into valid ones.

## 1. Locked decisions

1. **Scale modes:** MVP has exactly two modes.
   - **Target portions:** user enters desired portions.
     `factor = targetPortions / recipe.yieldPortions`.
   - **Anchor ingredient:** user picks one recipe line and enters the desired amount
     in a display unit.
     `factor = anchorTargetCanonical / anchorLine.quantity`.
2. **No quick multiplier buttons** in MVP.
3. **No persisted duplicate recipe** in MVP. "Duplicate as scaled recipe" is Phase 2.
4. **Hidden costs scale with the batch** for manager-only financial exports/previews.
   Labor, energy, and packaging are multiplied by the factor; they are not held flat.
5. **Anchor can produce fractional portions.** The UI may show "about 18.5 portions".
   Do not snap anchor mode to whole portions unless the owner explicitly changes this.
6. **Print/download contract:**
   - Both roles may use a new operational **scaled prep card** if included in MVP.
   - Managers may additionally use the existing financial recipe cost sheet with an
     optional scale parameter.
   - Kitchen must never receive the financial cost sheet.

## 2. Current-code facts the implementation must respect

| Topic | Current source of truth | Consequence |
| --- | --- | --- |
| Recipe page | `app/(app)/recipes/[id]/page.tsx` | Both roles can open the recipe editor. Kitchen receives `toKitchenRecipeWithIngredients`, with money keys stripped server-side. |
| Editor | `components/app/recipes/recipe-editor.tsx` | `canSeeCosts` controls cost columns, cost/pricing cards, and the existing cost-sheet link. |
| Financial cost sheet PDF | `app/api/recipes/[id]/card/pdf/route.ts` | Manager-only. Route returns 403 for kitchen before data access. |
| Financial cost sheet print | `app/(app)/recipes/[id]/card/print/page.tsx` | Manager-only. Kitchen sees `NoAccess`. |
| Cost sheet view-model | `lib/documents/recipe-card-data.ts` | Money-bearing view-model; do not reuse it for kitchen-visible prep output unless money fields are removed by type. |
| Recipe line quantity domain | `recipe_ingredients.quantity numeric(10,2)` in `lib/db/schema.ts` | Scaled recipe-line display should guard against `99_999_999.99`, not production's `numeric(12,2)` max. |
| Production explosion | `lib/calculations/production.ts` | Similar scaling discipline, but production applies yield/loss and aggregates for stock. Recipe scaling must not call production explosion. |
| Existing audit action | `export.recipeCardPdf` | Keep it for financial cost-sheet PDF. Add a distinct audit action for a new prep-card PDF if one is created. |

## 3. Scope and integration points

### Required for MVP

| Area | File(s) | Change |
| --- | --- | --- |
| Pure math | `lib/calculations/recipeScale.ts` + `lib/calculations/recipeScale.test.ts` | Factor derivation, line scaling, money scaling helpers, overflow guards. |
| Validation | `lib/validation/recipe-scale.ts` (new) | Zod schema for optional scale query params. Keep this separate from create/update recipe validation. |
| Recipe UI | `components/app/recipes/recipe-scale-panel.tsx` (new), mounted from `recipe-editor.tsx` | Client-side scale panel for both roles. Local recompute. No write. |
| i18n | `lib/i18n/messages/en.json` | Add `recipes.scale.*` labels/errors and, if needed, prep-card document labels. |

### Required if MVP includes print/download for kitchen

| Area | File(s) | Change |
| --- | --- | --- |
| Operational prep card view-model | `lib/documents/recipe-prep-card-data.ts` + test | Money-free document data. Accepts only operational recipe fields and line names/dimensions/quantities. |
| Operational prep card renderer | `lib/documents/recipe-prep-card-pdf.tsx` + labels/types | PDF without cost column or totals. |
| Operational prep card routes | `app/api/recipes/[id]/prep-card/pdf/route.ts`, `app/(app)/recipes/[id]/prep-card/print/page.tsx` | Both roles allowed. Org-scoped. PDF rate-limited and audited after successful render. |

### Manager-only optional extension

| Area | File(s) | Change |
| --- | --- | --- |
| Financial cost sheet scaling | `lib/documents/recipe-card-data.ts`, `lib/documents/types.ts`, `lib/documents/recipe-card-pdf.tsx`, `app/api/recipes/[id]/card/pdf/route.ts`, `app/(app)/recipes/[id]/card/print/page.tsx` | Add optional scale support to the existing manager-only cost sheet. Do not change its RBAC. |

## 4. Scaling arithmetic

Use a new pure module. Do not import production explosion for this feature.

```ts
export const RECIPE_SCALE_QUANTITY_MAX = 99_999_999.99;

export type RecipeScaleMode =
  | { kind: 'portions'; targetPortions: number }
  | { kind: 'anchor'; anchorLineQuantity: number; targetCanonical: number };

export type RecipeScaleResult =
  | { ok: true; factor: number; scaledPortions: number }
  | {
      ok: false;
      reason:
        | 'invalid_target'
        | 'invalid_anchor'
        | 'invalid_yield'
        | 'invalid_factor'
        | 'overflow';
    };
```

Contract:

```text
target portions:   factor = targetPortions / recipe.yieldPortions
anchor ingredient: factor = anchorTargetCanonical / anchorLine.quantity

scaledLineCanonical = line.quantity * factor
scaledPortions      = recipe.yieldPortions * factor
```

Rules:

- `recipe.yieldPortions` must be a positive finite number.
- Target portions must be positive and finite. They do **not** need to be integers,
  because anchor mode can legitimately produce fractional portions.
- Anchor line quantity and anchor target must be positive and finite.
- A factor of exactly `1` is identity.
- Accumulate/derive with unrounded numbers, then round scaled canonical quantities
  once to 2 decimals for display/export.
- Reject any scaled line above `RECIPE_SCALE_QUANTITY_MAX`.
- Anchor "reads back exactly" means exact by the active display precision after the
  canonical 2-decimal boundary. Do not promise infinite precision for oz/cup inputs.

### Yield/loss distinction

Do not copy production's formula:

```text
productionNeeded = line.quantity * plannedQty / yieldPortions / yieldFraction
```

Production uses that formula for stock consumption and shortfall. Recipe scaling is
not stock consumption. The scaled recipe/prep card shows the recipe's ingredient
lines multiplied by factor and keeps `yieldPercentage` as separate recipe metadata,
matching the existing recipe card behavior.

## 5. Manager-only money behavior

For managers only:

```text
scaledIngredientCostCents = round(originalIngredientCostCents * factor)
scaledLaborCostCents      = round(originalLaborCostCents * factor)
scaledEnergyCostCents     = round(originalEnergyCostCents * factor)
scaledPackagingCostCents  = round(originalPackagingCostCents * factor)
scaledTotalCostCents      = round(originalTotalCostCents * factor)

costPerPortionCents       = originalCostPerPortionCents
sellingPriceCents         = originalSellingPriceCents
marginPercent             = originalMarginPercent
```

Line-level cost on the manager cost sheet may be calculated from each unrounded
scaled line quantity, then rounded to cents. Batch totals should scale from the
original totals to preserve the invariant and avoid cent drift.

Kitchen behavior:

- Kitchen DTOs must not include recipe hidden costs, selling price, ingredient
  `priceCents`, line cost, batch totals, cost per portion, or margin.
- The scale panel should render nothing money-related for kitchen because those keys
  are absent, not because they are hidden in CSS.

## 6. Query params and validation

Use one scale query shape for all export routes:

```text
?portions=<positive decimal>
```

Rationale:

- `portions` is readable and bookmarkable.
- It supports target-portions mode directly.
- Anchor mode can pass the equivalent fractional portions without losing the exact
  factor.

Validation:

- Add `lib/validation/recipe-scale.ts`.
- Accept missing `portions` as "unscaled".
- Accept positive finite decimals up to a conservative max, recommended
  `1_000_000`.
- Limit decimal precision in the raw string, for example 4 decimal places, so URLs
  stay stable and accidental high-precision values are rejected.
- Reject `0`, negative, `NaN`, `Infinity`, blank, arrays, and over-max values.

Route behavior:

- API PDF route: invalid query returns `400`.
- Print page: invalid query renders the base unscaled card, or a small print-page
  error if that pattern already exists by implementation time. Pick one behavior and
  test it.

## 7. UI plan

Add `RecipeScalePanel` as a focused client component mounted inside
`RecipeEditor`, below the ingredients table or between ingredients and notes.

Props should be operational-first:

```ts
type ScalePanelLine = {
  id: string;
  ingredientId: string;
  name: string;
  dimension: Dimension;
  quantity: number;
};
```

Expected controls:

- Mode segmented control: Target portions / Anchor ingredient.
- Target portions numeric input, defaulting to `recipe.yieldPortions`.
- Anchor mode:
  - Select recipe line.
  - Numeric input.
  - Unit select defaulted by `pickDisplayUnit(line.quantity, dimension, measurementSystem)`.
  - Convert with `toCanonical` and display with `formatQuantity`/`fromCanonical`.
- Output:
  - Scaled portions caption, e.g. `4 -> 20 portions (x5)`.
  - Scaled ingredient quantities.
  - Manager-only scaled batch total preview if `canSeeCosts` and money fields exist.
- Actions:
  - Reset to x1.
  - Print/download operational prep card if implemented.
  - Manager-only link to scaled cost sheet if the optional financial extension is implemented.

Dirty-state rule:

- Export routes load the persisted recipe from the server.
- The on-screen panel may use current client state.
- Therefore, disable print/download while recipe header fields or line edits are
  dirty/pending, or clearly require the user to save before export. Do not let the UI
  show one scaled result and export a different saved recipe.

## 8. Export behavior

### Operational scaled prep card (both roles)

Preferred MVP path if the owner needs cooks to print/download:

- New print route: `/recipes/[id]/prep-card/print?portions=...`
- New PDF route: `/api/recipes/[id]/prep-card/pdf?portions=...`
- Both roles allowed.
- Load with `getRecipeWithIngredients` inside `withOrg`, then build a money-free
  view-model. For extra type safety, call `toKitchenRecipeWithIngredients` or map to
  an operational type before building.
- PDF route order:
  1. get org/user/role;
  2. rate-limit `documents`;
  3. parse query with Zod;
  4. `withOrg` load;
  5. build scaled operational view-model;
  6. render PDF;
  7. audit after successful render, e.g. `export.recipePrepCardPdf`;
  8. return `application/pdf` with `Cache-Control: no-store`.

### Existing financial recipe cost sheet (managers only)

If implemented:

- Keep current paths:
  - `/recipes/[id]/card/print?portions=...`
  - `/api/recipes/[id]/card/pdf?portions=...`
- Keep current manager-only gate:
  - PDF route uses `canSeeRecipeCosts(role)` and returns 403 for kitchen.
  - Print page uses `isManager()`/role gate and returns `NoAccess` for kitchen.
- Extend `buildRecipeCardData(data, settings, orgNameFallback, scale?)`.
- Add a header line such as `Scaled to 20 portions (x5)`.
- Keep `export.recipeCardPdf` audit action for the PDF route.
- If `SendDocumentDialog` remains on the scaled print page, extend
  `documentEmailSchema` and `renderDocumentForEmail` to include `portions`; otherwise
  hide/disable email on scaled views. Do not allow the user to email an unscaled PDF
  from a scaled print page.

## 9. Tests

Pure math: `lib/calculations/recipeScale.test.ts`

- target portions: `4 -> 20` gives `factor = 5`; `10 -> 5` gives `0.5`;
- anchor: anchored line displays back at the target amount/precision and other lines
  scale by the same factor;
- identity at factor `1`;
- fractional portions from anchor mode;
- round-once behavior at canonical 2-decimal boundary;
- rejects target `<= 0`, non-finite target, invalid yield, anchor line `<= 0`,
  anchor target `<= 0`, non-finite factor;
- rejects scaled line overflow above `99_999_999.99`.

Operational prep card tests, if implemented:

- no scale equals current recipe quantities;
- scale factor changes quantities and displayed portions;
- generated data has no money keys;
- kitchen and manager can access route;
- trashed/cross-org recipe returns 404;
- invalid `portions` returns 400 for PDF;
- PDF route audits only after successful render.

Financial cost sheet tests, if implemented:

- no scale preserves current `buildRecipeCardData` output except newly optional scale
  metadata being absent/null;
- scaled card multiplies quantities and batch totals;
- cost per portion, selling price, and margin are unchanged;
- PDF route remains 403 for kitchen;
- manager can request scaled PDF;
- invalid `portions` returns 400;
- scaled print page does not email the wrong unscaled document.

UI tests/manual QA:

- manager sees scaled quantities plus scaled batch total;
- kitchen sees scaled quantities and no money;
- anchor mode unit conversion works for metric and imperial org settings;
- export links are disabled or blocked while edits are dirty/pending;
- responsive layout does not overflow on mobile.

## 10. Definition of done

- New pure scale module and tests.
- Scale panel on recipe page for both roles.
- Kitchen payload remains money-free.
- If print/download is part of MVP, operational scaled prep card exists and is
  money-free for both roles.
- If manager financial scaling is part of MVP, existing cost sheet accepts optional
  `?portions=` without changing manager-only RBAC.
- No migration, no schema diff, no new dependency.
- Existing false/outdated PLANO wording about recipe-card kitchen access is not used
  as implementation guidance.
- Gates green:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

- Update `PLANO.md` only after code, tests, and docs pass: move
  `Recipe scaling/batch planning` out of Backlog and add a one-line note that the
  feature is DB-inert and has no production migration.

## 11. Explicit non-goals for this MVP

- No duplicate-as-scaled-recipe.
- No inventory reservation, stock shortfall, production posting, or ledger movement.
- No feature-plan entitlement gate.
- No email support for scaled documents unless the email schema/render path carries
  the same scale parameter.
- No changes to recipe/ingredient pricing models.
