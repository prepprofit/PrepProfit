# Plan - Recipe "Instructions / notes": UI placement + AI extraction persistence

**Status:** REVIEWED - ready for implementation.
**Reviewed date:** 2026-06-29
**Scope:** Move/rename the recipe notes UI and persist AI-extracted preparation notes from photo import through recipe creation.

---

## 1. Executive summary

This is a narrow, no-migration change.

1. On the recipe detail page, move the existing notes card so it renders before the **Scale batch** panel and rename the card title to **"Instructions / notes"**.
2. In the photo-import flow, keep `preparationNotes` visible/editable in the review workbench and carry it through the staged recipe payload, confirm-time validation, and `createRecipe`.

The database is already ready: `recipes.notes` exists and `createRecipe` accepts `notes` through `RecipeInput`.

---

## 2. Current diagnosis

The model extraction is not the failing layer. The value is extracted and kept in the editable draft, then lost when the draft is converted into the generic recipe-import payload.

| # | Stage | File | Current notes behavior |
|---|-------|------|------------------------|
| 1 | Extraction prompt/schema returns `preparationNotes` | `lib/ai/recipe-extraction.ts` | Extracted |
| 2 | Extraction -> editable draft mapping | `lib/ai/photo-draft.ts` | Carried as `draft.recipe.preparationNotes` |
| 3 | Photo workbench | `app/(app)/recipes/import/photo/photo-workbench.tsx` | Sent to stage, but not displayed/editable |
| 4 | Stage endpoint rebuilds trusted draft | `app/api/recipes/import/photo/stage/route.ts` | Carried into `PhotoExtractionDraft` |
| 5 | Draft -> `DraftRecipe` normalization | `lib/ai/photo-draft.ts` | Dropped |
| 6 | Recipe import draft/payload types | `lib/import/parse.ts`, `lib/import/types.ts` | No notes field |
| 7 | Confirm-time stored-payload validation | `lib/validation/import.ts` | No notes field; must be updated or Zod strips/invalidates the data |
| 8 | Import planner/apply | `lib/data/import.ts` | Not copied into `ImportRecipeRecord`; not passed to `createRecipe` |

**Important correction to the earlier draft:** `lib/validation/import.ts` is part of the persistence contract. `confirmImportAction` re-validates `job.normalizedRows` with `importRecipePayloadSchema` before applying a recipe/photo job, so the plan must update that schema too.

---

## 3. Implementation invariants

- **No migration.** Do not touch Drizzle schema/migrations for this change.
- **Human review stays mandatory.** AI-extracted instructions must appear in the workbench before staging/confirming.
- **No audit/log leakage.** Do not write note text into audit metadata; keep the existing count/id-only metadata pattern.
- **Confirm remains defense-in-depth.** The stored import-job JSON must validate with Zod before `applyRecipeImport`.
- **Existing staged jobs must still confirm.** The new `notes` field should be accepted as optional/defaulted to `null` in confirm-time validation, so already-staged recipe jobs without `notes` do not become invalid.
- **Saved recipes must remain re-editable.** Imported notes must obey the same 2000-character limit used by the manual recipe editor.

---

## 4. Change A - Recipe detail UI placement + label

**File:** `components/app/recipes/recipe-editor.tsx`

Current order:

`Main recipe grid -> Scale batch -> Notes`

Target order:

`Main recipe grid -> Instructions / notes -> Scale batch`

Implementation:

1. Move the existing notes `<Card>` currently after `<RecipeScalePanel />` so it renders immediately before the scale panel.
2. Keep the same `form.notes`, `setField({ notes: ... })`, placeholder, and save payload.
3. Change only the card title from `t('fields.notes')` to `t('fields.instructionsNotes')`.

**File:** `lib/i18n/messages/en.json`

Add:

```json
"instructionsNotes": "Instructions / notes"
```

under `recipes.fields`.

Keep `recipes.fields.notes` intact because other recipe/document surfaces still use "Notes" semantics.

---

## 5. Change B - Show extracted notes in the photo review workbench

**File:** `app/(app)/recipes/import/photo/photo-workbench.tsx`

Add an editable recipe-level textarea in `DraftWorkbench`, directly below the recipe name/yield header and before the ingredient groups.

Behavior:

- `value={draft.recipe.preparationNotes ?? ''}`
- `onChange={(e) => onPatchRecipe({ preparationNotes: e.target.value === '' ? null : e.target.value })}`
- Use the existing workbench styling pattern (`inputClass` or a small `textareaClass` derived from it); no new UI system required.
- Prefer `maxLength={RECIPE_NOTES_MAX_LENGTH}` once that constant is exported (see Change C), so the reviewed text matches what can be saved.

Add a translation key under `recipes.importPhoto.draft`, for example:

```json
"instructionsNotes": "Instructions / notes"
```

No route contract change is needed for this display field: `onStage` already sends `preparationNotes`, and `stagePhotoDraftSchema` already accepts it.

---

## 6. Change C - Normalize imported notes to the recipe-editor bound

There is a real bound mismatch today:

- Extraction/stage schemas allow `preparationNotes` up to 5000 chars.
- The recipe editor accepts recipe `notes` up to 2000 chars.

Resolve this by normalizing imported recipe notes to the recipe-editor limit before they become staged recipe data.

**File:** `lib/validation/recipes.ts`

Export a shared constant:

```ts
export const RECIPE_NOTES_MAX_LENGTH = 2000;
```

Use it in both `recipeSchema` and `kitchenRecipeSchema` instead of hard-coded `.max(2000)`.

**File:** `lib/ai/photo-draft.ts`

Import `RECIPE_NOTES_MAX_LENGTH` and add a small local helper:

```ts
function normalizeImportedRecipeNotes(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') return null;
  return trimmed.slice(0, RECIPE_NOTES_MAX_LENGTH);
}
```

Apply the helper in two places:

1. `mapExtractionToPhotoDraft`: set `preparationNotes` to the normalized value so fresh flows show the same text that can be saved.
2. `normalizePhotoDraftForImport`: set `DraftRecipe.notes` from the normalized `draft.recipe.preparationNotes` as a server-side backstop for edited/old/forged clients.

Keep `lib/ai/recipe-extraction.ts` and `lib/ai/photo-draft-schema.ts` at the current 5000-char anti-balloon cap unless the implementation deliberately widens the manual recipe editor too, which is out of scope.

---

## 7. Change D - Thread `notes` through the recipe import contract

**File:** `lib/import/parse.ts`

- Add `notes: string | null` to `DraftRecipe`.
- In `parseRecipes`, set `notes: null` for spreadsheet imports. Do not add a spreadsheet notes column in this change.

**File:** `lib/import/types.ts`

- Add `notes: string | null` to `ImportRecipeRecord`.
- Document that it is already normalized to the recipe editor limit and is `null` for current file imports.

**File:** `lib/validation/import.ts`

Add `notes` to `importRecipeRecordSchema`:

```ts
notes: z
  .string()
  .trim()
  .max(RECIPE_NOTES_MAX_LENGTH)
  .transform((s) => (s === '' ? null : s))
  .nullable()
  .optional()
  .default(null),
```

This file should import `RECIPE_NOTES_MAX_LENGTH` from `lib/validation/recipes.ts`.

Reason for `.optional().default(null)`: new jobs should store `notes`, but older parsed jobs that do not have the field must remain confirmable.

**File:** `lib/ai/photo-draft.ts`

In `normalizePhotoDraftForImport`, add:

```ts
notes: normalizeImportedRecipeNotes(draft.recipe.preparationNotes),
```

to the built `DraftRecipe`.

**File:** `lib/data/import.ts`

- In `planRecipeImport`, copy `notes: recipe.notes` into each `ImportRecipeRecord`.
- In `applyRecipeImport`, pass `notes: recipe.notes` to `createRecipe`.

Result: photo imports create recipes whose `recipes.notes` contains the reviewed preparation method.

---

## 8. Files touched

| File | Change |
|------|--------|
| `components/app/recipes/recipe-editor.tsx` | Reorder notes card; use `fields.instructionsNotes` |
| `app/(app)/recipes/import/photo/photo-workbench.tsx` | Add editable instructions/notes textarea to draft review |
| `lib/i18n/messages/en.json` | Add editor + photo-draft label keys |
| `lib/validation/recipes.ts` | Export/reuse `RECIPE_NOTES_MAX_LENGTH` |
| `lib/ai/photo-draft.ts` | Normalize and carry `preparationNotes` -> `DraftRecipe.notes` |
| `lib/import/parse.ts` | Add `DraftRecipe.notes`; spreadsheet recipes set `null` |
| `lib/import/types.ts` | Add `ImportRecipeRecord.notes` |
| `lib/validation/import.ts` | Add backward-compatible `notes` schema to stored recipe payload |
| `lib/data/import.ts` | Copy notes in planner and pass them to `createRecipe` |
| Tests listed below | Cover normalization, staging, confirmation, and spreadsheet null path |

---

## 9. Test plan

Run targeted tests first, then the full gate.

### Unit/integration tests to update

**`lib/ai/photo-draft.test.ts`**

- `mapExtractionToPhotoDraft` keeps `preparationNotes`.
- Blank/whitespace notes normalize to `null`.
- Notes longer than `RECIPE_NOTES_MAX_LENGTH` are truncated before display/import.
- `normalizePhotoDraftForImport` places the normalized value on `recipes[0].notes`.

**`tests/recipe-photo-route.test.ts`**

- In the successful extraction test, set the mocked `goodRecipe.preparationNotes` to a real method string and assert the response draft includes it.
- In the stage test, assert:
  - `preview.recipePayload.recipes[0].notes` equals the method string.
  - the stored `importJobs.normalizedRows` also contains that note.

**`tests/recipe-photo-confirm.test.ts`**

- Include `notes` in the staged `photoPayload`.
- After `confirmImportAction`, query `recipes` and assert the created row's `notes` equals the method string.

**`tests/import-recipes-parse.test.ts`**

- Assert spreadsheet `parseRecipes` produces `notes: null`.

**`tests/import-recipes-data.test.ts`**

- Assert `planRecipeImport` preserves `notes` on the payload for a constructed/photo-style `DraftRecipe`, or rely on the route test for that path and assert spreadsheet-created recipes keep `notes: null`.

### Commands

```bash
npm test -- lib/ai/photo-draft.test.ts tests/recipe-photo-route.test.ts tests/recipe-photo-confirm.test.ts tests/import-recipes-parse.test.ts tests/import-recipes-data.test.ts
npm run lint
npm run typecheck
npm test
npm run build
```

---

## 10. Manual verification

Use the real "Fudge" image path already referenced by the eval harness:

`eval/extraction/images/image-asset.webp`

Expected result:

1. Photo extraction returns a draft whose **Instructions / notes** field contains the preparation method.
2. The workbench shows the field before staging, and the user can edit it.
3. Staging/confirming creates the recipe.
4. The recipe detail page shows **Instructions / notes** before **Scale batch**.
5. The saved notes remain editable and saving the recipe again does not fail validation.

This manual/live check requires the configured extraction provider key in `.env.local`.

---

## 11. Out of scope

- Adding a method/instructions column to spreadsheet recipe imports.
- Changing recipe-card/prep-card PDF labels from "Notes" to "Instructions / notes".
- Raising the manual recipe editor notes limit above 2000.
- Scoring notes/instructions in the eval golden metrics.
- Persisting any raw image text or note content in audit metadata.
