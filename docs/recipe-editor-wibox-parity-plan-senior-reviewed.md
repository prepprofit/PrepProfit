# Recipe Editor Wibox Parity - Senior-Reviewed Implementation Plan

> **Status: SENIOR-REVIEWED plan, ready for owner decision + implementation.**
>
> Reviewed against `PrepProfit-main (34).zip` on 2026-06-30.
> Original plan reviewed: `docs/recipe-editor-wibox-parity-plan.md`.
>
> Verdict: the draft was directionally strong, especially on multi-tenancy, RBAC,
> cents-based money and test expectations. It was not yet "top-notch ready" because
> the weight basis was still ambiguous, preset scaling was framed too close to the
> existing ingredient-anchor mode, cost leakage boundaries needed to be sharper, and
> reorder/accessibility/concurrency needed a stricter contract. This revision turns
> those into implementation decisions.

## 0. Outcome

Bring the useful Wibox edit-recipe affordances into PrepProfit without copying
Wibox's weaker assumptions:

1. Reorder recipe ingredients.
2. Show a live recipe summary strip:
   - batch yield weight,
   - manager-only live batch cost,
   - manager-only cost per kg.
3. Add kitchen presets: named target finished weights, such as "18cm Cake" or
   "Individual portion", that can scale the existing recipe in one click.

Non-negotiable PrepProfit boundaries:

1. Every write is org-scoped with server-derived `organizationId` inside `withOrg`.
2. Kitchen users never receive recipe money fields, ingredient `priceCents`,
   batch totals, per-kg cost or preset cost previews in props, payloads, DOM, route
   responses, or exports.
3. Money remains integer cents. Physical weights are numeric canonical grams.
4. All user input is validated with Zod on the server.
5. UI copy and action errors go through `next-intl`.
6. The existing scale/export dirty gate remains: exports use persisted recipe data,
   so print/download must be disabled while on-screen edits are unsaved.
7. Migrations are generated and applied locally only until the SQL and Drizzle meta
   diff are reviewed.

## 1. Current-Code Facts

These are confirmed in the ZIP and should guide implementation:

| Topic | Current source | Consequence |
| --- | --- | --- |
| Recipe page loader | `app/(app)/recipes/[id]/page.tsx` | Kitchen receives `toKitchenRecipeWithIngredients`, which strips recipe money fields and line `priceCents` server-side. New preset data must follow the same operational-only DTO rule. |
| Editor | `components/app/recipes/recipe-editor.tsx` | Cost calculation currently runs only when `canSeeCosts` is true. Keep it that way. Do not compute money for kitchen and then hide it. |
| Recipe lines | `lib/db/schema.ts`, `lib/data/recipe-ingredients.ts` | `recipe_ingredients.sort_order` already exists and reads already order by it. Reordering needs no schema change. |
| Existing line update | `updateRecipeIngredient` | It can update `sortOrder`, but reorder should still get a dedicated batch function so the set check and updates are atomic. |
| Recipe scaling | `lib/calculations/recipeScale.ts`, `components/app/recipes/recipe-scale-panel.tsx` | Scaling is DB-inert and already supports target portions plus ingredient anchor. Presets should integrate here, not create a parallel scaling system. |
| Recipe cost | `lib/calculations/recipeCost.ts` | Costs are pure, integer-cents at output, and line quantities are canonical g/ml/count. Add per-kg helpers here or next to it, with tests. |
| Units | `lib/units/index.ts` | Store weights in canonical grams; display with `formatQuantity(..., 'weight', measurementSystem)`. |
| Formula safety | `lib/finance/csv.ts`, `lib/documents/xlsx.ts` | Spreadsheet formula protection already exists via `neutralizeFormula` and `textCell`. Reuse it for any new spreadsheet output; do not put export-specific escaping into the Zod name schema. |
| Audit | `lib/data/audit.ts` | Operational config can be audited, but metadata must stay ids/counts/status only. If new audit actions are added, extend the `AuditAction` union and tests. |

## 2. Locked Senior Decisions

### D1 - Use Explicit Batch Yield Weight

Do **not** base cost/kg or kitchen presets on "sum of weight-dimension ingredient
lines" as the default implementation.

That shortcut is attractive because it avoids a recipe migration, but it is not
top-notch for PrepProfit:

- it ignores volume and count lines in the denominator while still counting their
  cost in the numerator,
- it treats raw ingredient mass as finished output mass,
- it conflicts with baking/cooking loss,
- it makes preset scaling wrong for recipes with liquids, eggs, packaging units, or
  meaningful evaporation.

Add an explicit nullable recipe field:

```text
recipes.yield_weight_grams numeric(10,2) NULL
```

Meaning: usable finished batch/output weight for the recipe as currently written.
It is operational data, visible/editable by both manager and kitchen, like
`yieldPortions` and `yieldPercentage`.

Existing recipes remain valid with `NULL`; do not backfill or infer a value from
ingredient lines.

### D2 - Cost/kg Is Manager-Only and Requires Yield Weight

`costPerKgCents = round(totalCostCents * 1000 / yieldWeightGrams)`

Only compute and render it when:

- `canSeeCosts === true`,
- `yieldWeightGrams` is finite and greater than zero,
- `totalCostCents` is finite integer cents.

Kitchen sees the weight tile, not cost/kg or live batch cost.

### D3 - Presets Are Target Finished Weights

A kitchen preset stores a named **target finished weight**, not an ingredient anchor.

Scaling to a preset uses:

```text
factor = preset.targetWeightGrams / recipe.yieldWeightGrams
```

If the recipe has no `yieldWeightGrams`, presets can still be managed, but scale
buttons and manager cost previews are disabled/blank until the base yield weight is
set.

### D4 - Add a Real Weight Scale Mode

Do not fake presets by pre-filling the existing ingredient-anchor mode. A target
finished weight is not one line's target amount.

Extend `RecipeScaleMode` with a third pure mode:

```ts
| { kind: 'yieldWeight'; baseWeightGrams: number; targetWeightGrams: number }
```

Keep exports on the existing `?portions=` contract by converting the successful
weight mode to equivalent scaled portions in the client, as the panel already does
for anchor mode.

### D5 - Reorder Accessibility Is Required

Wibox's native HTML5 drag-and-drop is a good visual reference, but mouse-only
reorder is not enough for a kitchen-facing SaaS.

Default implementation:

- keep no new dependency,
- add a grip handle and native drag/drop for pointer users,
- add explicit Move up / Move down icon buttons or keyboard handling for keyboard
  and touch fallback,
- use localized `aria-label`s.

Optional owner-approved upgrade: use `@dnd-kit` for pointer/touch/keyboard DnD.
Do not add it without explicit stack approval.

### D6 - Audit Presets, Not Ingredient Reorder

Ingredient reorder is low-risk presentation/order metadata and can remain unaudited.

Preset CRUD/reorder should be audited because presets are reusable kitchen operating
configuration that can drive printed prep output. Metadata should contain ids/counts
and changed-field names only, not preset names or weight values.

Add audit actions:

```ts
| 'recipePreset.create'
| 'recipePreset.update'
| 'recipePreset.delete'
| 'recipePreset.reorder'
```

## 3. Feature A - Reorder Recipe Ingredients

### Scope

No migration. Use existing `recipe_ingredients.sort_order`.

### Validation

Add to `lib/validation/recipes.ts`:

```ts
export const reorderRecipeIngredientsSchema = z.object({
  orderedLineIds: z
    .array(z.string().trim().min(1))
    .min(1)
    .max(1000)
    .superRefine(rejectDuplicates),
});
```

Use a real duplicate check. Duplicate ids should be `INVALID_INPUT`, not silently
accepted.

### Data Layer

Add a dedicated function in `lib/data/recipe-ingredients.ts`:

```ts
export type ReorderRecipeIngredientsOutcome =
  | { status: 'ok'; count: number }
  | { status: 'not_found' }
  | { status: 'stale' };
```

Behavior:

1. Confirm the parent recipe is active and org-scoped.
2. Lock the current recipe lines in deterministic id order with `FOR UPDATE`.
3. Compare the current line id set with `orderedLineIds`.
4. If the sets differ exactly, return `stale`.
   - This catches partial payloads, foreign ids, removed lines, and concurrent
     add/remove between page load and drop.
5. Update all `sortOrder`s sequentially in one `withOrg` transaction.
6. Return count.

Do not call `updateRecipeIngredientAction` once per row from the client. That would
create partial-persist failure modes and unnecessary revalidations.

### Server Action

Add to `app/(app)/recipes/actions.ts`:

```ts
reorderRecipeIngredientsAction(recipeId: string, input: unknown)
```

Action order:

1. Zod parse.
2. `getOrgId()`.
3. `withOrg(...)`.
4. Map outcomes:
   - `not_found` -> `NOT_FOUND`
   - `stale` -> new `RECIPE_LINES_CHANGED`
5. `revalidatePath('/recipes')` and `revalidatePath(`/recipes/${recipeId}`)`.

Add `RECIPE_LINES_CHANGED` to `ActionErrorCode` and `actionErrors`:

```text
The recipe ingredients changed. Reload and try again.
```

### UI

In `components/app/recipes/recipe-editor.tsx`:

- Import `GripVertical`, `ChevronUp`, `ChevronDown` or equivalent lucide icons.
- Add a narrow reorder column before ingredient name.
- Keep stable column widths so the table does not shift while dragging or saving.
- On drop:
  - snapshot previous `lines`,
  - optimistically reorder,
  - set `linesDirty(true)`,
  - call `reorderRecipeIngredientsAction(recipe.id, { orderedLineIds })`,
  - on success clear `linesDirty`,
  - on failure restore previous lines, clear dirty state, show `actionError`.
- Move up/down buttons use the same action path.
- Disable reorder controls while `pending`.
- Keep print/download disabled while `pending || headerDirty || linesDirty`.

Do not use raw `blue-500` classes from Wibox. Use PrepProfit tokens:
`border`, `brand-*`, `muted-foreground`, `surface-*`, `destructive`.

### Tests

Add or extend `tests/recipe-ingredients.test.ts`:

- active recipe exact reorder persists by `sortOrder`,
- foreign id in payload returns stale/no writes,
- partial id set returns stale/no writes,
- duplicate id payload is rejected at validation/action boundary,
- trashed parent recipe returns `not_found`,
- order survives `getRecipeWithIngredients` reload.

Action/RBAC:

- both manager and kitchen can reorder,
- no money fields are needed or selected for reorder.

## 4. Feature B - Batch Yield Weight, Cost/kg, Live Cost Strip

### Schema and Migration

Add nullable `yield_weight_grams` to `recipes`:

```ts
yieldWeightGrams: numeric('yield_weight_grams', { precision: 10, scale: 2 })
```

No default. Existing recipes should render `-` / "not set" rather than a guessed
weight.

Generate migration `0034` locally. If presets are implemented in the same sprint,
the migration can include both this column and `recipe_presets`.

### Types and Data

Update:

- `Recipe` inferred type via schema,
- `RecipeInput`,
- `KitchenRecipe`,
- `toKitchenRecipe`,
- `recipeSchema`,
- `kitchenRecipeSchema`,
- recipe create/update paths,
- import/photo staging only if they construct full recipe payloads.

Kitchen can edit `yieldWeightGrams` because it is operational physical data and
does not expose cost.

Validation:

```ts
yieldWeightGrams: z.number().finite().positive().max(99_999_999.99).nullable().optional()
```

UI should convert a blank input to `null` before submit.

### Calculations

Add pure helpers near `lib/calculations/recipeCost.ts`:

```ts
export function costPerKgCents(
  totalCostCents: number,
  yieldWeightGrams: number | null | undefined,
): number | null
```

Contract:

- return `null` for null/undefined/0/negative/non-finite weight,
- reject or return `null` for non-finite total cost,
- compute cents with one final `Math.round`,
- do not format money here.

Do **not** compute preset cost from already-rounded cost/kg. For preset unit cost,
scale the batch total by the exact factor and round once:

```text
presetCostCents = round(totalCostCents * targetWeightGrams / yieldWeightGrams)
```

### UI

In the Parameters card:

- add `Batch yield weight`,
- store/display in canonical grams using the org measurement system,
- keep editing ergonomic:
  - numeric input,
  - unit select for weight units (`displayUnitsFor('weight', measurementSystem)`),
  - convert with `toCanonical` on save and `fromCanonical` for display.

Above the ingredients table, add a compact metric strip:

- Weight: visible to both roles, `formatQuantity(yieldWeightGrams, 'weight', measurementSystem)` or `-`.
- Live Cost: manager only, existing `cost.totalCostCents`.
- Cost/kg: manager only, `costPerKgCents(...)`.

Use small dashboard-style tiles, not a marketing hero. This is an operational tool.

### Tests

Add/extend `lib/calculations/recipeCost.test.ts`:

- zero/null weight -> `null`,
- negative weight -> `null`,
- NaN/Infinity weight -> `null`,
- normal `totalCostCents/yieldWeightGrams` rounding,
- large in-domain values,
- preset cost rounds once from total and factor.

Add validation tests:

- accepts null/positive finite weight,
- rejects zero, negative, NaN, Infinity and over max.

## 5. Feature C - Kitchen Presets

### Schema

Add `recipe_presets`:

```text
recipe_presets
  id                  text primary key
  organization_id     text not null
  recipe_id           text not null
  name                text not null
  target_weight_grams numeric(10,2) not null check (> 0)
  sort_order          integer not null default 0
  created_at          timestamptz not null default now()
  updated_at          timestamptz not null default now()

Indexes / constraints:
  index recipe_presets_org_idx on (organization_id)
  index recipe_presets_org_recipe_sort_idx on (organization_id, recipe_id, sort_order)
  unique recipe_presets_org_id_key on (organization_id, id)
  unique recipe_presets_org_recipe_name_key on (organization_id, recipe_id, lower(name))
  fk (organization_id, recipe_id) -> recipes(organization_id, id) on delete cascade
```

Add `'recipe_presets'` to `businessTables` so RLS is generated.

Use a case-insensitive per-recipe name uniqueness constraint if Drizzle/PGlite accept
the functional index cleanly. If not, enforce duplicate detection in the data layer
and keep a normal `(organization_id, recipe_id)` index.

### Validation

Create `lib/validation/recipe-presets.ts`:

```ts
export const MAX_RECIPE_PRESETS = 30;

name:
  string, trim, min 1, max 80

targetWeightGrams:
  finite positive number, max 99_999_999.99

orderedPresetIds:
  distinct non-empty ids, max MAX_RECIPE_PRESETS
```

Formula-injection note: do not mutate the stored name to neutralize formulas. Store
the user's literal name. Any spreadsheet renderer must use existing `textCell` /
`neutralizeFormula`.

### Data Layer

Create `lib/data/recipe-presets.ts`:

- `listRecipePresets(db, organizationId, recipeId)`
- `addRecipePreset(db, organizationId, recipeId, input)`
- `updateRecipePreset(db, organizationId, recipeId, presetId, input)`
- `removeRecipePreset(db, organizationId, recipeId, presetId)`
- `reorderRecipePresets(db, organizationId, recipeId, orderedPresetIds)`

Rules:

1. Every function is org-scoped.
2. Mutations only apply to active parent recipes.
3. Add/update reject duplicate names.
4. Add rejects more than `MAX_RECIPE_PRESETS`.
5. Reorder locks current preset rows and requires the exact current set.
6. All writes run inside caller `withOrg`.

### Server Actions

Create `app/(app)/recipes/preset-actions.ts`.

Actions:

- `addRecipePresetAction(recipeId, input)`
- `updateRecipePresetAction(recipeId, presetId, input)`
- `removeRecipePresetAction(recipeId, presetId)`
- `reorderRecipePresetsAction(recipeId, input)`

RBAC:

- both kitchen and manager can manage preset name/weight,
- no manager gate,
- no cost fields accepted.

Audit:

- resolve `auditActor()` once per action,
- write audit in the same `withOrg` transaction as the mutation,
- metadata examples:
  - create: `{ presetId }`
  - update: `{ presetId, changedFields: ['name', 'targetWeightGrams'] }`
  - delete: `{ presetId }`
  - reorder: `{ count }`

No names, no weight values, no costs in audit metadata.

Action errors:

- `INVALID_INPUT`
- `NOT_FOUND`
- `DUPLICATE_NAME`
- `RECIPE_PRESETS_CHANGED` for stale reorder
- optionally `RECIPE_PRESET_LIMIT_REACHED` if the cap needs a distinct message

### Page Loader and DTOs

Update `app/(app)/recipes/[id]/page.tsx`:

- load presets with the recipe page data,
- pass presets to `RecipeEditor`,
- presets are operational-only: `{ id, name, targetWeightGrams, sortOrder }`.

No cost or derived cost preview should be loaded from the server for kitchen.
Managers can derive cost preview client-side because their editor already receives
recipe cost inputs.

### UI in Recipe Editor

Add a "Kitchen Presets" section near the scaling panel, not as a separate scaling
system.

Recommended layout:

1. Preset management list:
   - name,
   - formatted target weight,
   - manager-only estimated cost for that target when `yieldWeightGrams` and cost
     are available,
   - remove button,
   - move controls if reorder is implemented.
2. Add row:
   - preset name input,
   - target weight input + unit select,
   - add button.
3. Empty state:
   - short localized text, no instructional paragraph overload.

Cost preview:

```text
manager only
if cost && yieldWeightGrams > 0:
  round(cost.totalCostCents * targetWeightGrams / yieldWeightGrams)
else:
  -
```

Kitchen sees only name and target weight.

### Integration in RecipeScalePanel

Extend `RecipeScalePanel` props:

```ts
type ScalePreset = {
  id: string;
  name: string;
  targetWeightGrams: number;
};
```

Also pass `yieldWeightGrams`.

Panel behavior:

- add mode/button group for target weight,
- render preset buttons such as localized "Scale to {name}",
- on preset click:
  - set mode to `yieldWeight`,
  - set target weight to preset value,
  - derive factor via `deriveScale(...)`,
  - show the same result list and export buttons as other modes.
- if base yield weight is not set:
  - disable preset scale buttons,
  - show localized compact hint in the scale panel.

Do not persist scaled recipe lines. Presets are saved; scaling remains derive-on-read.

## 6. Cross-Cutting Implementation Rules

### Multi-Tenancy

- `recipe_presets` carries `organization_id`.
- It is in `businessTables`.
- All queries filter `organizationId`.
- All writes run inside `withOrg`.
- The parent recipe FK is composite `(organization_id, recipe_id)`.
- Client never sends `organization_id`.

### RBAC and Money

- Reorder: both roles.
- Yield weight: both roles.
- Preset name/weight: both roles.
- Cost/kg, live cost, per-preset cost: manager only.
- Kitchen DTOs must not contain `priceCents`, hidden costs, selling price, batch
  totals, cost/kg, per-preset cost, or money-bearing document URLs.

### i18n

Add keys under:

- `recipes.summary.*`
- `recipes.presets.*`
- `recipes.scale.*`
- `actionErrors.RECIPE_LINES_CHANGED`
- `actionErrors.RECIPE_PRESETS_CHANGED`
- optional `actionErrors.RECIPE_PRESET_LIMIT_REACHED`

No hardcoded user-visible strings.

### Migration Discipline

Migration `0034` should include:

- `recipes.yield_weight_grams`,
- `recipe_presets`,
- indexes/constraints,
- updated RLS statements through `businessTables`.

Generate with:

```text
npm run db:generate
```

Apply locally only until the SQL and `drizzle/meta/_journal.json` diff are reviewed.

### Exports

No export route needs to accept a `presetId` in v1. The scale panel can convert a
preset click into equivalent `?portions=...` for existing prep/cost sheet routes.

If preset names are later included in XLSX/CSV, use `textCell` /
`neutralizeFormula`. PDF/React text is escaped by the renderer, but still avoid
putting preset names in audit metadata.

## 7. Test Plan

### Pure Calculation Tests

`lib/calculations/recipeCost.test.ts`

- `costPerKgCents` null/zero/negative/non-finite weight,
- rounding boundaries,
- large values,
- preset target cost scales from total cost and exact factor.

`lib/calculations/recipeScale.test.ts`

- new `yieldWeight` mode happy path,
- rejects missing/zero/negative/non-finite base weight,
- rejects missing/zero/negative/non-finite target weight,
- overflow guard still applies to scaled line quantities,
- scaled portions are derived correctly.

### Data Tests

`tests/recipe-ingredients.test.ts`

- exact ingredient reorder persists,
- stale/partial/foreign reorder fails without partial writes,
- trashed parent fails.

New `tests/recipe-presets.test.ts`

- CRUD on active recipe,
- refuses trashed/missing/foreign parent,
- duplicate name rejected,
- cap enforced,
- exact reorder persists,
- stale/partial/foreign preset reorder fails without partial writes.

### RLS Tests

Extend `tests/isolation.test.ts` or add focused preset isolation tests:

- SELECT isolation for `recipe_presets`,
- INSERT `WITH CHECK` rejects wrong org,
- UPDATE retag attempt rejects wrong org,
- DELETE cannot reach another org,
- composite FK rejects cross-org recipe link.

### Action/RBAC Tests

- Kitchen can reorder ingredients.
- Kitchen can CRUD presets.
- Kitchen payloads/actions cannot submit or receive cost fields.
- Manager sees cost/kg and per-preset cost.
- Kitchen does not receive `priceCents` or any derived cost prop.
- Stale reorder maps to localized stable action errors.

### Export and Security Tests

- Existing prep-card and cost-sheet RBAC remains unchanged.
- Preset scale export uses `?portions=` and respects dirty-state disabled UI.
- If preset names enter XLSX/CSV output, formula-looking names are neutralized.
- Audit rows for preset mutations contain ids/counts/changed fields only.

### Gate

Before merge:

```text
npm run lint
npm run typecheck
npm test
npm run build
```

## 8. Suggested Commit Slicing

1. `feat(recipes): persist batch yield weight`
   - schema + migration `0034` local,
   - validation/data/types/UI field,
   - calculation helper tests.

2. `feat(recipes): show batch metrics`
   - summary strip,
   - manager-only live cost and cost/kg,
   - i18n and tests.

3. `feat(recipes): reorder ingredients`
   - batch data function/action,
   - accessible UI controls + optimistic update,
   - stale error handling and tests.

4. `feat(recipes): add recipe presets data model`
   - `recipe_presets` schema in the same local migration if not already generated,
   - RLS/businessTables,
   - data layer and tests.

5. `feat(recipes): manage kitchen presets`
   - actions,
   - audit,
   - editor management UI,
   - i18n and RBAC tests.

6. `feat(recipes): scale recipe by preset weight`
   - `yieldWeight` scale mode,
   - preset buttons in `RecipeScalePanel`,
   - export dirty-gate preserved,
   - tests.

If the owner wants the fastest visible win first, Feature A can still ship before
the migration work because ingredient reorder is independent.

## 9. Explicitly Not in Scope

- No stored scaled recipe lines.
- No production posting, stock reservation, or inventory movement.
- No automatic inference of yield weight from ingredient lines.
- No kitchen access to financial cost sheets.
- No `presetId` route parameter in exports for v1.
- No new DnD dependency unless the owner explicitly approves it.
- No copying Wibox's float money or single-tenant assumptions.

## 10. What Changed From the Original Draft

The original plan was good, but this revision tightens the parts that matter most:

1. Replaces ambiguous "weight-only basis" with explicit `yield_weight_grams`.
2. Changes preset scaling from "prefill anchor" to a real target-weight scale mode.
3. Adds exact-set stale handling for ingredient and preset reorder.
4. Requires accessible reorder controls, not mouse-only drag/drop.
5. Specifies no cost leakage through kitchen DTOs, props, DOM or server responses.
6. Uses existing formula-neutralization helpers instead of putting export escaping in
   validation.
7. Makes preset audit behavior explicit and privacy-safe.
8. Adds caps, duplicate handling, RLS tests, action errors and commit slicing.

