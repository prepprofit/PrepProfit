# Suggested Batch Yield Weight - Senior Implementation Plan

Status: SENIOR-REVISED implementation spec, 2026-07-09. No code written yet for
this feature.

Goal: reduce friction on the recipe editor's `Batch yield weight` field by
showing an optional, one-click estimate from the recipe's known weight-bearing
lines. The stored manual field remains the only source of truth. The suggestion
never auto-saves and never writes on blur.

## Senior Verdict

The original draft was close on scope, but it was not safe to hand to a dev as-is.
It assumed four locale files where this repo currently has one, left product
questions open, and most importantly proposed multiplying by `yieldPercentage`.

Do not do that in this repo. `yieldPercentage` is already the production/cost
loss factor used to inflate required inputs (`/ yieldFraction`). Applying it
again to the UI suggestion would create a different physical model than the one
encoded in `recipeCost()`, `explodeProduction()`, and recipe scaling. This
feature is only an estimate for the manual finished-batch-weight field, not a new
yield/loss model.

This revised plan is approved for implementation if followed as written.

## Current Repo Contracts To Preserve

Verified against the current PrepProfit codebase:

- `recipes.yield_weight_grams` already exists as nullable canonical grams and is
  operational data visible/editable by both manager and kitchen.
- The recipe editor stores the field as `form.yieldWeightText` plus
  `yieldWeightUnit`, then converts to canonical grams with `toCanonical()` and
  rounds to 2 decimals before saving.
- `yieldWeightGramsLive` already drives the summary weight tile for both roles,
  manager-only cost/kg, and recipe preset cost previews.
- The editor already has direct ingredient `lines` and sub-recipe `components`
  in local state. Component quantities are grams of finished sub-recipe output.
- Kitchen payloads strip money, but keep quantities, yield fields, ingredients,
  and component quantities. This feature must not introduce money into kitchen
  props.
- Sub-recipe cost cascading already uses `componentMaterialCostsCents`; this plan
  must not touch that money path.
- The only message file currently present is `lib/i18n/messages/en.json`.
- Tests run in the existing Vitest `node` environment; do not introduce a browser
  component-test stack just for this feature.

## Locked Product Decisions

1. The suggestion is visible to both manager and kitchen roles.
2. The suggestion is computed client-side from data the recipe editor already
   has. No schema, migration, RLS, route, or Server Action change.
3. The suggestion includes direct weight ingredient lines and finished-weight
   sub-recipe component lines.
4. The suggestion skips direct volume/count ingredient lines because the app has
   no density or per-piece mass table.
5. The suggestion does **not** multiply by `yieldPercentage`.
6. Apply only updates the form field; the user still presses Save.
7. Hide the hint when there is no usable suggestion or when the current live
   field already equals the suggestion at the canonical 0.01 g boundary.
8. The copy must say this is an estimate from known weights, not a measured final
   yield.

## Calculation Contract

Add a pure module:

```text
lib/calculations/suggestedYieldWeight.ts
lib/calculations/suggestedYieldWeight.test.ts
```

Suggested API:

```ts
import type { Dimension } from '@/lib/units';

export type SuggestedYieldWeightInput = {
  lines: { dimension: Dimension; quantityCanonical: number }[];
  components: { quantityGrams: number }[];
};

export type SuggestedYieldWeight = {
  grams: number | null;
  skippedLines: number;
  includedWeightLines: number;
  includedComponents: number;
};

export function suggestedYieldWeight(
  input: SuggestedYieldWeightInput,
): SuggestedYieldWeight;
```

Rules:

- Add `quantityCanonical` only for direct lines where `dimension === 'weight'`
  and the quantity is finite and positive.
- Add `quantityGrams` for components when finite and positive.
- Count direct `volume` and `count` lines as skipped.
- Count direct weight lines with non-finite or negative quantities as skipped.
- Zero weight lines are ignored but not counted as skipped; they behave like
  unfinished placeholder quantities.
- Components with non-finite, zero, or negative quantities are ignored but not
  surfaced as skipped. Persisted component quantities are already strictly
  positive; this is only a UI-state guard.
- Return `grams: null` when the total included grams is 0.
- Round the returned grams once to 2 decimals, matching the existing
  `yieldWeightGramsLive` boundary.
- Do not accept or read `yieldPercentage`.

Examples:

```text
1000 g flour + 200 g sugar                 -> 1200 g
1000 g flour + 100 ml milk + 2 eggs        -> 1000 g, skippedLines = 2
300 g ganache component + 500 g cake base  -> 800 g
100 ml milk only                           -> null, skippedLines = 1
```

## UI Contract

Implement in `components/app/recipes/recipe-editor.tsx`.

Placement:

- Render directly under the existing `Batch yield weight` input group inside the
  `Field label={t('fields.yieldWeight')}` block.
- Keep it visually compact: one muted helper line plus a small outline Apply
  button. Do not add a new card or modal.

Derivation:

```ts
const yieldSuggestion = suggestedYieldWeight({
  lines: lines.map((line) => ({
    dimension: line.ingredient.dimension,
    quantityCanonical: line.quantity,
  })),
  components: components.map((line) => ({ quantityGrams: line.quantityGrams })),
});
```

Visibility:

- Show only when `yieldSuggestion.grams !== null`.
- Hide when `yieldWeightGramsLive !== null` and
  `Math.abs(yieldWeightGramsLive - yieldSuggestion.grams) < 0.01`.
- Show even while there are skipped lines, but include the partial-note text.
- Disable Apply while `pending`.

Apply behavior:

```ts
setField({
  yieldWeightText: numberToText(
    fromCanonical(yieldSuggestion.grams, yieldWeightUnit),
  ),
});
```

Notes:

- Do not change `yieldWeightUnit` on Apply.
- Do not call `updateRecipeAction`.
- Do not re-run server loaders.
- Do not put the suggestion into saved recipe data unless the user saves the form.
- The existing Save flow continues to enforce `yieldWeightGrams` validation and
  the sub-recipe in-use yield guard.

Copy:

- Main line: `Estimated from known weights: ~{value}`
- Partial line: `{count} lines without weight not included`
- Reuse `recipes.pricing.apply` for the button label unless product wants a
  different word later.

Formatting:

- Format `{value}` with `formatQuantity(grams, 'weight', measurementSystem)`.
- Keep the `~` prefix in the localized string so the estimate cannot be mistaken
  for a measured yield.

## i18n

Add only to `lib/i18n/messages/en.json` under the `recipes.fields` namespace:

```json
{
  "yieldWeightSuggestion": "Estimated from known weights: ~{value}",
  "yieldWeightSuggestionPartial": "{count, plural, one {# line without weight not included} other {# lines without weight not included}}"
}
```

Do not reference non-existent locale files. If more locales are added later, this
key will be included in the normal localization pass.

## RBAC And Security

- Both roles can see and apply the suggestion because it is operational physical
  data.
- The helper receives only dimensions and quantities. It does not receive prices,
  costs, margins, component `unitCostCentsPerGram`, or selling price.
- Kitchen payload shape stays money-free.
- No audit event: the suggestion itself is not a mutation; the eventual recipe
  Save remains the existing recipe update action.
- No new server-side trust boundary. A forged client can still only submit the
  normal `yieldWeightGrams` field, which is already validated server-side.

## Tests

Pure tests in `lib/calculations/suggestedYieldWeight.test.ts`:

- all direct weight lines sum and round to 2 decimals
- mixed weight/volume/count returns the weight sum plus skipped count
- components-only suggestion
- direct weight plus components
- empty recipe returns `grams: null`
- all non-weight recipe returns `grams: null` and skipped count
- zero quantities ignored
- negative/non-finite weight lines skipped
- invalid component quantities ignored
- regression: no `yieldPercentage` input and no yield-loss multiplication

Editor smoke coverage:

- Keep this as implementation-level/manual verification unless the repo already
  has a frontend test harness by the time this lands. Current Vitest config is
  `environment: 'node'`; do not add React Testing Library or jsdom only for this.
- At minimum, typecheck must prove the helper is wired with the actual
  `Line`/`ComponentLine` shapes.

Manual QA:

1. Metric org, blank yield weight: 1000 g + 250 g shows `~1.25 kg`; Apply writes
   `1.25` if the current unit is kg.
2. Imperial org, blank yield weight: 454 g shows a sensible lb/oz formatted
   estimate; Apply writes the value in the currently selected unit.
3. Recipe with 1000 g flour, 100 ml milk, and 2 eggs shows the estimate plus the
   skipped-line note.
4. Recipe with only volume/count lines shows no Apply hint.
5. Recipe with a 300 g component and 500 g direct weight suggests 800 g.
6. Kitchen role sees the same operational hint and still receives no money keys.
7. Applying the hint does not save until Save is pressed.
8. Existing manager cost/kg and preset previews update from the live field after
   Apply, exactly as they do when typing manually.

## Rollout Slices

1. `feat(calculations): add suggested yield weight helper`
   - pure module
   - unit tests

2. `feat(recipes): show suggested batch weight in editor`
   - recipe editor derivation
   - compact hint + Apply
   - `en.json` strings

Gate before merge:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Out Of Scope

- Density tables or volume-to-weight conversion.
- Per-ingredient count weights such as "1 egg = 50 g".
- Auto-filling the field on create.
- Saving the suggestion without the user's explicit Save.
- Server-side calculation or persistence of a suggested value.
- Using `yieldPercentage` as a cooked-loss multiplier for this hint.
- New analytics or audit events.
- Component tree recursion beyond the component lines already present in the
  editor. A parent recipe uses the grams of its immediate component line, not the
  child's raw ingredient breakdown, for this UI estimate.

## Definition Of Done

- The plan ships without schema, migration, RLS, or Server Action changes.
- The helper is pure, tested, and independent of money/cost data.
- The editor shows a concise suggestion only when it is useful.
- Apply updates the unsaved form value in the current weight unit.
- Volume/count gaps are disclosed with a partial note.
- Kitchen users can use the feature without receiving money fields.
- Existing cost/kg, presets, sub-recipe cost, production, sale, and prep/reorder
  behavior remain unchanged.
