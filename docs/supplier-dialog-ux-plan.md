# Supplier dialog + ingredients list — UX fixes (plan)

Four briefs from Guilherme (2026-08-05), verified against the code before planning.
They all touch two files, so they run in ONE session, in the order below.

Primary files:

- `components/app/ingredients/ingredient-supplier-dialog.tsx`
- `components/app/ingredients/ingredient-grid.tsx`
- `components/ui/input.tsx`, `app/(app)/ingredients/page.tsx`, `lib/i18n/messages/en.json`

## Status of each claim (verified, not assumed)

| # | Claim | Verdict |
|---|---|---|
| 1 | Supplier field is a `datalist`, not a dropdown | **Confirmed.** `ingredient-supplier-dialog.tsx` L369–384. Data is fine (`supplierNames` ← `listSuppliersWithCounts`), the widget is wrong. |
| 2 | Generic "check the values" banner, no field-level errors | **Confirmed.** The dialog has one `error` state rendered as a top banner; no per-field messages. |
| 3 | `"25 kg kg"` doubled unit | **Confirmed, root cause found.** `formatInUnit()` (`lib/units/index.ts:163`) already appends the label, and the dialog appends `unitLabel(unit)` again. One-line fix. |
| 4 | Remove the "Your pantry…" subtitle | **Confirmed.** `app/(app)/ingredients/page.tsx:88`. |
| 5 | Incomplete-first ordering was lost | **Confirmed, and partly addressed already.** Commit `5cc353d` dropped the implicit float; `b043ee3` added "Needs pricing first" as a 5th sort key — that is Guilherme's **Option B**, and he leans **A**. See §5. |
| 6 | No `autoComplete` anywhere → password managers guess | **Confirmed.** `grep autoComplete` over `components/` + `app/` returns nothing; `components/ui/input.tsx` sets no default. |
| 7 | "Units" vs "Unit" labels confusing | **Confirmed.** `ingredients.…` / `suppliers.ingredientEditor` keys `unitsPerPack: "Units"`, `packSize: "Pack size"`, `packUnit: "Unit"`. |

## Two decisions — DECIDED (André delegated both, 2026-08-05)

### D1 — Save stays enabled for a name-only supplier; the pack fields are conditional

Brief 1 Fix B says: keep Save disabled until pack size + price + unit are present.

Today a manager can save **just a supplier name** with no pack and no price, and that is
deliberate: `ingredientSupplierSchema` marks every pack field optional, `setDefaultSupplier`
handles a name-only input, and `tests/suppliers.test.ts` covers it. It is the "I know who
supplies this, I do not know the pack yet" record.

Disabling Save until pack + price exist deletes that flow.

**DECISION:** the requirement is CONDITIONAL, not absolute.

- Supplier name alone → Save stays ENABLED. It records "this is who supplies it", which is a
  legitimate half-finished state and the flow the tests already protect.
- The moment ANY of price / pack size / unit is non-empty, the other two become REQUIRED, with
  inline errors on whichever is empty. A partial pack cannot produce a cost per unit, so the
  three travel together or not at all.
- Save is therefore only ever disabled while the pack trio is half-filled — a state the user
  created and can see marked, never a dead end on an untouched form.

Why this over a blanket disable: the brief's real complaint is the dead-end generic banner, not
that name-only saves exist. A blanket disable would fix the message by deleting a capability,
and the user would have no way at all to record a supplier before knowing its pack — which is
the normal order in which a kitchen learns these two facts.

### D2 — "Incomplete" means the COST is untrustworthy; a missing supplier does not qualify

The brief says "no supplier, no price, needsPricing true, etc.". Two traps:

1. Kitchen rows carry **no `priceCents` key at all** (Sprint F4 strips it server-side), so any
   predicate that reads price marks the entire kitchen list incomplete.
2. Pinning on "no supplier" lights up most of the list on day one, and a pin that matches
   almost every row stops being a signal.

**DECISION:**

```ts
/**
 * Incomplete = this row's COST cannot be trusted right now. That is the only thing
 * worth stealing the top of the list for: a wrong price silently corrupts every
 * recipe that uses the ingredient. Price only participates when the viewer can see
 * prices — kitchen payloads carry no price key at all (Sprint F4).
 */
const isIncomplete = (r: IngredientRow, canSeeCosts: boolean) =>
  r.needsPricing || (canSeeCosts && (r.priceCents ?? 0) === 0);
```

`needsPricing` alone is not enough on its own: a manager can create an ingredient with no price
typed and the flag stays false, so `priceCents === 0` catches that hole. Both conditions mean
the same thing to the user — "this ingredient is costing your recipes at zero".

**A missing supplier is deliberately NOT pinned.** It is a real gap, but a different and
lesser one: it makes purchasing incomplete, not costing wrong. It already has its own
affordances — the `Set supplier` button on the row and the `Supplier` sort key, which groups
unsupplied rows together on demand. Pinning it would drown the rows that are actively lying
about money.

If Guilherme later wants supplier gaps surfaced too, the right shape is a separate filter
("show only unsupplied"), not a second pinning tier.

## Work items, in order

### 1. Trivia first (safe, isolated)

- **Doubled unit**: in the dialog's `totalLabel`, drop the trailing `unitLabel(unit)` —
  `formatInUnit` already includes it. Add a unit test in `lib/units/index.test.ts` if one
  does not already pin this.
- **Subtitle**: delete the `<p>{t('subtitle')}</p>` from `app/(app)/ingredients/page.tsx` and
  the now-unused `ingredients.subtitle` key from `lib/i18n/messages/en.json`.

### 2. `autoComplete` inoculation

- `components/ui/input.tsx`: default `autoComplete="off"`, overridable —
  `({ autoComplete = 'off', ...props })`, spread AFTER so a caller wins.
- Same for `components/ui/textarea.tsx`.
- Add `data-1p-ignore` + `data-lpignore="true"` on the supplier + add-ingredient dialog
  inputs only (the documented fallback for managers that ignore `off`).
- **Check for regressions**: grep for forms that legitimately want autofill (settings business
  address, customer form). None use a `type="password"`, and Clerk renders its own sign-in
  UI with its own components, so app-wide `off` does not touch real login.

### 3. Incomplete-first ordering (Option A)

- Wrap, do not replace: keep `SORT_COMPARATORS` and add one tier on top, using the D2
  predicate (`canSeeCosts` is already a prop of the grid).

  ```ts
  const compare = (a, b) =>
    Number(isIncomplete(b, canSeeCosts)) - Number(isIncomplete(a, canSeeCosts)) ||
    SORT_COMPARATORS[sortKey](a, b);
  ```

- **Remove the `needsPricing` sort key** added in `b043ee3`. With Option A the pinning is
  unconditional, so a sort option that says the same thing is a second, contradictory way to
  express it. Drop the key + its `sort.options.needsPricing` string.
- Keep the amber badge exactly as is.
- Export `isIncomplete` so it is unit-testable without rendering the grid.
- Tests: incomplete first under EVERY sort key; sort still applies within each group; a row
  that becomes complete drops into its normal position; and a kitchen row (no `priceCents`
  key) with `needsPricing: false` is NOT flagged — the regression D2 exists to prevent.

### 4. Supplier picker: datalist → searchable combobox

- Reuse the existing pattern rather than inventing one: `app/(app)/import/recipe-resolution.tsx`
  drives `components/ui/command.tsx` (cmdk) as a searchable picker. Same primitives here.
- Requirements: full list visible on open with no typing; typing filters; a free-text name
  that matches nothing is still submittable (create-on-save is already how
  `findOrCreateSupplierByName` works — do NOT add a separate create action).
- Keep `supplierNames` as the data source. No server change.
- Watch: the dialog's `seededFor` effect keys off the typed supplier name to adopt that
  supplier's remembered price basis / VAT mode. Whatever replaces the input must keep firing
  that on selection, or the prefill silently stops working.

### 5. Field-level validation + conditional Save (per D1)

- Replace the single `error` string with a small `Record<field, messageKey>` and render each
  message under its field, plus an error ring on that input.
- Keep the top banner ONLY for server-returned `ActionResult` codes (`VAT_RATE_REQUIRED`,
  `SUPPLIER_INACTIVE`, …) — those are not field-scoped.
- Save enablement per D1: disabled ONLY while the pack trio (price / size / unit) is
  half-filled. An untouched form with just a supplier name saves.
- New i18n keys under `suppliers.ingredientEditor.fieldErrors.*`.
- Test the predicate that decides "half-filled" as a pure function — it is the rule most
  likely to drift, and it is what stands between a manager and a dead-end Save button.

### 6. "What you buy" as a sentence

- Layout: `[ Packs ] × [ Size of each ] [ unit ▾ ]`, literal `×` between the first two.
- Rename i18n values only (keys can stay to keep the diff small, but renaming the keys to
  `packs` / `sizeOfEach` reads better — either is fine, be consistent):
  `Units → Packs`, `Pack size → Size of each`, unit dropdown label blank/visually hidden.
- Helper text: "Most items are 1 pack. Increase 'Packs' only for a case (e.g. 4 × 1,65 kg)."
- **No schema change.** Still `units_per_pack` / `pack_size` / `pack_unit`. Default Packs = 1
  (already the case).
- Accessibility: a blank visible label still needs an `aria-label` on the unit select.

## Out of scope

VAT (shipped in `b043ee3`), the price-basis block (per pack / per unit / per kg), the catalog
redesign, and multiple suppliers per ingredient.

## Definition of done

`npm run lint && npm run typecheck && npm test && npm run build` clean, plus:

- Supplier dialog opens showing every supplier without typing; typing filters; a new name
  still saves; the remembered price basis still prefills on selection.
- Missing pack fields produce inline messages on those fields, not only a top banner.
- "Total per purchase" shows one unit.
- Incomplete ingredients (untrustworthy cost — D2) pinned on top under every sort key, badge
  intact; unsupplied-but-priced rows are NOT pinned.
- A name-only supplier still saves; Save is disabled only on a half-filled pack.
- No password-manager prompt when opening either dialog.
- "What you buy" reads `Packs × Size of each [unit]`; no two fields called some form of "unit".
