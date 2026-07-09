# Sub-Recipes (Recipe-in-Recipe) - Senior Implementation Plan

Status: SENIOR-REVISED implementation spec, 2026-07-09. No code written yet.
Scope: let a recipe use another recipe as a finished component line, with live
cost cascade, allergen inheritance, raw-ingredient stock explosion, and safe
trash/purge semantics, without changing how existing plain ingredient lines work.

## Senior Verdict

The original draft had the right product shape and the right instinct to use a
separate table. It still needed revision before implementation because it left
money semantics, sale/production consumption, yield invariants, and restore/purge
guards partly open.

This revised plan is the implementation contract. There are no "dev confirm"
decisions left. If the team disagrees with one of the locked decisions below,
change this document before coding, not midway through the implementation.

## Current Repo Contracts To Preserve

Verified against the current PrepProfit codebase:

- Recipe costs are derive-on-read in `lib/calculations/recipeCost.ts`; no stored
  recipe cost cache exists today.
- `recipes.yield_weight_grams` already exists as canonical grams,
  `numeric(10,2, mode: 'number')`, and may be null for existing recipes.
- `costPerKgCents()` and `presetCostCents()` already price a finished-weight
  slice from the exact batch total and return `null` when yield weight is missing.
- `recipe_ingredients` is single-purpose: it joins recipes to ingredients with
  composite same-org FKs. Do not make it polymorphic.
- `componentCost()` is the house complete-or-null pattern used by menus and
  productions: no partial sum, no silent zero.
- Production and sale stock explosions are intentionally single-level today.
  Sub-recipes must update those paths in v1 or stock will be wrong.
- Allergens are derive-on-read from ingredient tags plus recipe overrides.
  Overrides add/escalate only; clear never suppresses a derived allergen.
- Kitchen payloads strip money server-side in `lib/data/recipes.ts`; costs are
  manager-only, while yield, quantities, notes, and allergens are operational.
- RLS is generated from `businessTables`; every business table must be listed
  there and covered by isolation tests.

## Locked Product Decisions

1. Sub-recipes are separate component lines, stored in a new
   `recipe_components` table.
2. v1 unit is grams of the component recipe's finished output only.
3. A recipe must be active and have `yield_weight_grams > 0` to be used as a
   component.
4. A recipe already used by an active parent cannot have its yield weight cleared.
5. Max nesting depth is 5, enforced at write time and guarded again at read time.
6. Components are material inputs, not hidden costs. Direct ingredients and
   component raw costs are summed before the parent recipe's yield-loss
   adjustment. Labor, energy, and packaging remain after loss adjustment, exactly
   as they are today.
7. v1 must expand sub-recipes to raw ingredients for production, sales, and
   prep/reorder math. Hiding component-bearing recipes from those flows is not
   acceptable.
8. Component line edits are operational like ingredient line edits: kitchen may
   edit quantities/reorder/remove, but manager-only cost fields and previews stay
   stripped from kitchen payloads.
9. No `audit_log` events for component add/update/remove/reorder in v1, matching
   recipe ingredient lines. Lifecycle mutations that already audit remain audited.

## Schema And Migration

Add `recipeComponents` to `lib/db/schema.ts`:

```ts
export const recipeComponents = pgTable(
  'recipe_components',
  {
    id: id(),
    organizationId: orgId(),
    recipeId: text('recipe_id').notNull(),
    componentRecipeId: text('component_recipe_id').notNull(),
    quantityGrams: numeric('quantity_grams', {
      precision: 10,
      scale: 2,
      mode: 'number',
    }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    index('recipe_components_org_idx').on(t.organizationId),
    index('recipe_components_org_recipe_sort_idx').on(
      t.organizationId,
      t.recipeId,
      t.sortOrder,
    ),
    index('recipe_components_org_component_idx').on(
      t.organizationId,
      t.componentRecipeId,
    ),
    unique('recipe_components_org_parent_component_key').on(
      t.organizationId,
      t.recipeId,
      t.componentRecipeId,
    ),
    check('recipe_components_not_self_chk', sql`${t.recipeId} <> ${t.componentRecipeId}`),
    check('recipe_components_quantity_chk', sql`${t.quantityGrams} > 0`),
    check('recipe_components_sort_order_chk', sql`${t.sortOrder} >= 0`),
    foreignKey({
      columns: [t.organizationId, t.recipeId],
      foreignColumns: [recipes.organizationId, recipes.id],
      name: 'recipe_components_parent_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.componentRecipeId],
      foreignColumns: [recipes.organizationId, recipes.id],
      name: 'recipe_components_component_fk',
    }).onDelete('restrict'),
  ],
);
```

Migration requirements:

- Add `recipe_components` to `businessTables` so standard org-isolation RLS and
  FORCE RLS apply.
- Generate the next sequential migration with `npm run db:generate`.
- Review the SQL diff before applying outside local dev.
- Add RLS coverage for SELECT isolation, INSERT WITH CHECK, UPDATE retag
  rejection, and DELETE reachability.

## Validation And Action Contract

Add to `lib/validation/recipes.ts`:

- `recipeComponentSchema`: `componentRecipeId` non-empty, `quantityGrams`
  finite, `> 0`, `<= 100_000_000`, optional non-negative `sortOrder`.
- `recipeComponentUpdateSchema`: same positive `quantityGrams`, optional
  `sortOrder`.
- `reorderRecipeComponentsSchema`: exact ordered id list, same pattern as
  `reorderRecipeIngredientsSchema`.

Add `ActionErrorCode`s and `actionErrors` translations:

- `RECIPE_COMPONENT_INVALID`: missing, cross-org, trashed, self, or no-yield
  component at add/update time.
- `RECIPE_COMPONENT_ALREADY_EXISTS`: duplicate component line for a parent.
- `RECIPE_CYCLE`: the proposed line would make the graph cyclic.
- `RECIPE_DEPTH_EXCEEDED`: the proposed line would exceed
  `MAX_COMPONENT_DEPTH = 5`.
- `RECIPE_COMPONENTS_CHANGED`: stale reorder payload; no write happened.
- `RECIPE_COMPONENT_REQUIRES_YIELD`: an in-use component recipe tried to clear
  `yield_weight_grams`.
- `RECIPE_IN_COMPONENT`: recipe cannot be trashed/purged because an active or
  surviving component row references it.

Add Server Actions in `app/(app)/recipes/actions.ts`:

- `addRecipeComponentAction(recipeId, input)`
- `updateRecipeComponentAction(recipeId, componentLineId, input)`
- `removeRecipeComponentAction(recipeId, componentLineId)`
- `reorderRecipeComponentsAction(recipeId, input)`

All actions must get org from `getOrgId()`, validate with Zod, run inside
`withOrg`, revalidate the parent recipe and ancestor recipes, and never trust a
client-sent org, cost, name, yield, or availability value.

## Data Layer And Write Invariants

Create `lib/data/recipe-components.ts`.

Required functions:

- `listRecipeComponents(db, orgId, recipeIds[])`
- `listComponentPickerRecipes(db, orgId, parentRecipeId)`
- `addRecipeComponent(db, orgId, input)`
- `updateRecipeComponent(db, orgId, parentRecipeId, lineId, input)`
- `removeRecipeComponent(db, orgId, parentRecipeId, lineId)`
- `reorderRecipeComponents(db, orgId, parentRecipeId, orderedLineIds)`
- `countActiveParentsUsingComponent(db, orgId, componentRecipeId)`
- `countAnyParentsUsingComponent(db, orgId, componentRecipeId)`
- `lockRecipeComponentEndpoints(db, orgId, recipeIds[])`
- `assertNoRecipeComponentCycle(db, orgId, parentId, componentId)`

Write rules:

- Parent recipe must be active for add/update/remove/reorder.
- Component recipe must be active and have `yieldWeightGrams > 0` for add.
- Update/remove/reorder match `organization_id`, `recipe_id`, and line id.
- Reorder locks the current component lines `FOR UPDATE` in deterministic id
  order and requires an exact id set, same as ingredient reorder.
- Add locks the parent and component recipe rows `FOR UPDATE` in deterministic
  id order before running the DAG check.
- DAG check uses a recursive CTE from `componentRecipeId` downward through
  `recipe_components`; reject if `parentId` is reachable.
- The same check rejects a write whose longest resulting chain would exceed 5.
- Read resolvers still carry `visited` and `depth` guards and return incomplete,
  never throw or loop, if corrupted data somehow exists.

Concurrency requirement:

- PGlite tests cover normal cycle/depth logic.
- Add an opt-in real-Postgres test in `tests/concurrency/recipe-components.pg.test.ts`
  proving concurrent A->B and B->A inserts cannot both commit.

## Yield, Trash, Restore, And Purge Invariants

The invariant is:

> An active parent recipe may only reference active component recipes with a
> positive finished yield weight.

Implement the invariant everywhere it can be broken:

- Add component line: require active component with positive yield weight.
- Update recipe: if the recipe is used by any active parent component line,
  reject clearing `yieldWeightGrams` with `RECIPE_COMPONENT_REQUIRES_YIELD`.
- Trash recipe: before `softDeleteRecipe`, lock incoming active parent/component
  references and reject trashing an active component with `RECIPE_IN_COMPONENT`.
- Restore recipe: lock referenced component recipes and reject restore if any
  component is trashed/missing or lacks positive yield weight.
- Purge parent recipe: `ON DELETE cascade` removes its outgoing component lines.
- Purge component recipe: `ON DELETE restrict` blocks while any surviving
  component row references it; add `RECIPE_IN_COMPONENT` to
  `purgeRecipeWithGuards` before calling `purgeRecipe`.

This intentionally mirrors ingredient-line safety while respecting recipe Trash:
a trashed parent may keep its component rows, but it cannot be restored until the
component references are valid again.

## Cost Cascade

Extend the pure cost layer without adding I/O:

- Keep `recipeCost()` as the single batch-cost function.
- Extend `RecipeCostInput` with `componentMaterialCostsCents?: number[]`, or add
  a sibling helper that prepares an expanded material cost bucket before calling
  `recipeCost()`.
- Do not feed rounded display line costs back into totals.

Locked math:

```text
componentRawCostCents =
  subRecipeTotalCostCents * quantityGrams / subRecipeYieldWeightGrams

rawMaterialCostCents =
  directIngredientRawCostCents + sum(componentRawCostCents)

materialCostAfterParentLoss =
  rawMaterialCostCents / parentYieldFraction

totalBatchCostCents =
  round(materialCostAfterParentLoss + labor + energy + packaging)
```

Notes:

- `componentRawCostCents` may be fractional internally, just like direct
  `lineCostCents()` can be fractional before the final batch rounding.
- Display a component line cost as a rounded integer, but keep resolver totals
  rounded once at the batch boundary.
- A component with missing/invalid yield weight, cycle guard failure, depth guard
  failure, missing recipe, or trashed recipe makes the resolved parent cost
  incomplete (`costCents: null`), never zero.
- Existing unpriced ingredients keep today's behavior: their `priceCents` is 0
  and cost previews still compute exactly as they do now.

Create one shared server resolver, for example
`lib/data/recipe-cost-tree.ts`:

```ts
resolveRecipeCostTree(db, organizationId, recipeIds): Promise<Map<string, RecipeCostResolution>>
```

The resolver must batch-load the whole component closure with one recursive CTE,
then batch-load recipes, direct ingredient lines, component lines, and prices for
the closure. No consumer should grow its own recursion or N+1 component loader.

Switch all live cost consumers to the resolver:

- recipe editor data load and manager-only cost preview metadata
- recipe list manager KPIs
- recipe card print/PDF data
- menus and menu engineering
- productions current cost previews and completion cost freeze
- dashboard aggregate feeder
- profit leaks and cost-impact calculations
- daily close insights
- CFO report data
- prep/reorder plan inputs where costs or component expansion are needed

Regression requirement: component-free recipes must produce identical cost
results before and after this change.

## Raw-Ingredient Explosion For Stock And Prep

Production, sales, and prep/reorder must traverse components in v1.

Create a shared pure explosion module, or extend the existing production
explosion with a graph-aware helper:

```ts
explodeRecipeTreeToIngredients(input): ProductionExplosion
```

Required semantics:

```text
parentScaleAfterLoss =
  requestedPortions / parentYieldPortions / parentYieldFraction

directIngredientContribution =
  line.quantity * parentScaleAfterLoss

componentFinishedOutputNeeded =
  component.quantityGrams * parentScaleAfterLoss

childBatchScale =
  componentFinishedOutputNeeded / child.yieldWeightGrams
```

Then recurse into the child recipe using the child's own yield portions,
yield percentage, direct ingredients, and components.

Update these callers:

- `lib/data/productions.ts`: `loadExplosionInputs`, previews, plan readiness,
  completion snapshot, and stock movements.
- `lib/data/sales.ts`: `resolveSaleConsumption`, posted sale stock movements, and
  menu-derived recipe consumption.
- `lib/data/prep-reorder-plan.ts` and `lib/calculations/prep-reorder-plan.ts`:
  recipe/menu demand should include sub-recipe raw ingredients.

Behavior:

- Any trashed/missing/no-yield component makes the explosion incomplete.
- Incomplete production cannot be planned or completed.
- Incomplete sale cannot be posted when `movesStock` is true.
- Prep/reorder surfaces a named issue rather than silently omitting component
  ingredients.
- Requirements remain aggregated by raw ingredient id and rounded once to the
  existing `numeric(12,2)` storage boundary.

## Allergen Inheritance

Extend the pure allergen rollup to accept inherited component rollups:

```ts
recipeAllergens({
  ownIngredientLines,
  inheritedComponentRollups,
  overrides,
})
```

Rules:

- Derived allergens = max(own ingredient-derived allergens, component effective
  allergens).
- Parent overrides apply after derived/inherited allergens and still add/escalate
  only.
- Inherited allergens are treated as derived for no-downgrade purposes.
- `hasUnreviewedIngredient` must become true if any direct ingredient or component
  subtree has unreviewed ingredient allergens.
- Read-time recursion uses the same `MAX_COMPONENT_DEPTH` and visited-set guards
  as cost.

Update all allergen loaders:

- `loadRecipeAllergenRollup`
- `loadOrgRecipeAllergens`
- `loadRecipeAllergensByIds`
- recipe allergen override actions that call `loadRecipeAllergenRollup`
- menu kitchen/manager allergen unions
- allergen matrix PDF/XLSX routes

## UI And RBAC

Recipe editor:

- Add a "Sub-recipes" section near ingredient lines.
- Picker lists active same-org recipes with positive `yieldWeightGrams`.
- Picker excludes self and should hide obvious cycle candidates, but the server
  remains authoritative.
- Quantity input is grams of finished component output.
- Component lines have independent ordering within the component section.
- Manager view shows component line cost and parent cost impact.
- Kitchen view shows name and quantity only; no component cost, no batch cost,
  no cost/kg, and no selling price data in the payload.

Recipe detail data shape:

- Extend `RecipeWithIngredients` with `components`.
- Extend kitchen DTOs with component id, component recipe id, component name,
  quantity grams, sort order, and no money fields.
- Manager DTO may include resolved component cost metadata when needed for live
  preview, but the server remains the source of truth for saved/exported totals.

Component picker:

- Needs enough metadata to format the finished weight and explain disabled states.
- It must not ship money to kitchen users.

Revalidation:

- A component line change can affect the parent and all ancestors. Add a helper
  like `revalidateRecipeGraph(parentRecipeId)` that revalidates `/recipes`, the
  touched recipe pages, and high-level derived surfaces such as dashboard, menus,
  productions, and prep/reorder pages.

## Documents And Exports

Recipe card print/PDF:

- Manager-only surface stays manager-only.
- Render direct ingredient lines and component lines as separate sections.
- Component section shows name, finished grams used, and manager-only line cost.
- Totals use `resolveRecipeCostTree`, not local single-level recomputation.
- If cost resolution is incomplete, render the existing dash/incomplete state.

Prep card print/PDF:

- Operational, money-free surface remains available to both roles.
- Render component lines as a separate section with name and finished grams used.
- Do not expose costs.

Allergen matrix PDF/XLSX:

- Inherited component allergens must appear exactly like derived allergens.
- Keep existing "no allergens recorded" wording and disclaimer behavior.

XLSX/text output:

- Continue using existing formula-injection-safe text helpers for component names.

## Rollout Slices

Each slice should land as a conventional commit with green tests before the next.

1. Schema, migration, `businessTables`, generated RLS, and isolation tests.
2. Pure math: component material cost, graph-aware ingredient explosion, and
   allergen inheritance tests.
3. `lib/data/recipe-components.ts`: CRUD, stale reorder, active/no-yield guards,
   cycle/depth checks, and data-layer tests.
4. Shared `resolveRecipeCostTree` and replacement of all live cost consumers.
5. Shared graph-aware stock/prep explosion and replacement of production, sale,
   and prep/reorder consumers.
6. Allergen loader recursion and matrix/menu/override-action integration.
7. Recipe editor UI, picker, RBAC DTO stripping, i18n strings, and revalidation.
8. Trash/restore/purge guards, recipe card/prep card exports, final regression
   tests, and docs/checklist updates.

## Test Matrix

Pure tests:

- Component raw cost: missing/zero/negative/non-finite yield, fractional cents,
  large values, and round-once total behavior.
- Cost trees: 2-level and 3-level components, parent loss applied to direct and
  component material inputs, hidden costs not loss-adjusted.
- Explosion trees: direct lines, nested components, aggregation by raw ingredient,
  overflow, invalid math, missing/no-yield/trashed component incomplete states.
- Allergens: inherited contains/may-contain, override escalation, clear never
  suppresses inherited, unreviewed flag bubbles up.

Data-layer/PGlite tests:

- Same-org composite FK behavior and RLS matrix for `recipe_components`.
- Add/update/remove/reorder active-parent checks.
- Duplicate component rejected.
- Self-reference rejected by CHECK and action.
- 2-cycle and 3-cycle rejected by CTE.
- Depth 6 rejected.
- Clearing yield on an active in-use component rejected.
- Trash active in-use component rejected.
- Restore parent with trashed/no-yield component rejected.
- Purge parent cascades outgoing component rows.
- Purge component with surviving references returns `RECIPE_IN_COMPONENT`.

Integration tests:

- Component-free recipes remain byte-for-byte equivalent for cost-facing results
  where existing tests assert exact values.
- Menus with component-bearing recipes compute cost/allergens correctly.
- Production plan readiness and completion consume raw ingredients through
  components and freeze the same aggregate raw consumptions.
- Posted stock-moving sale consumes raw ingredients through recipe and menu
  component trees.
- Prep/reorder demand includes raw ingredients from sub-recipes.
- Recipe card PDF/print includes component section for managers.
- Prep card PDF/print includes component quantities without money.
- Kitchen recipe payloads never include component costs or inherited money keys.

Real Postgres opt-in test:

- Concurrent A->B and B->A component inserts cannot persist a cycle.

Gate before merge:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Run the opt-in real-Postgres concurrency test before launch when
`TEST_DATABASE_URL` is available.

## Explicitly Out Of Scope For V1

- Portion-mode component input. It can be added later by converting portions to
  grams with `yieldWeightGrams / yieldPortions`.
- Volume-based component input.
- Treating prepared sub-recipes as stocked inventory items.
- Production planning for sub-recipes as separate prep jobs.
- AI photo extraction or CSV/XLSX import that emits component links.
- Component-level lineage snapshots inside production/sale history. V1 freezes
  top-level recipe snapshots plus aggregate raw-ingredient consumptions.
- New duplicate-recipe UX. There is no existing duplicate recipe flow in the repo;
  if it is added later, it must copy component lines with the recipe.
- Cached/materialized recipe costs.

## Definition Of Done

- Existing ingredient-line behavior is unchanged.
- A component-free org sees no cost, allergen, production, sale, prep/reorder, or
  export behavior changes except harmless refactors.
- Active parent recipes cannot reference trashed/no-yield component recipes.
- Cycles cannot be persisted, including under real Postgres concurrency.
- Live cost cascades through nested recipes everywhere costs are shown.
- Allergens inherit through nested recipes everywhere allergens are shown.
- Sales, production, and prep/reorder traverse components to raw ingredients.
- Kitchen users can manage operational component lines without receiving money
  fields in server payloads.
- Manager-only documents and views include component costs; operational documents
  do not.
