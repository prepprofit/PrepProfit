# AI Photo Recipe Extraction - Production-Grade Improvement Plan

**Status:** approved implementation plan after senior review  
**Date:** 2026-06-27  
**Scope:** `/recipes/import/photo`, the AI extraction contract, photo review UI, unit parsing, staging, and regression/eval coverage. No stack rewrite.

**Launch rule:** this feature must not be used as the marketing hook until the acceptance gates in section 10 pass. The hook is not "AI reads a photo"; the hook is "AI gives a complete, editable recipe draft that the chef can fix and trust before saving."

---

## 1. Executive Decision

The current feature is not shippable as a headline workflow. The model is not the main failure. In the Baklava test, Gemini read much of the photo, but our deterministic mapping and review contract discarded the most important lines.

The production fix is not a prompt tweak and not a model swap. The fix is a stronger product contract:

1. Every active ingredient line the model reads must be visible in the review UI.
2. Lines that cannot yet become canonical recipe data must be shown as `needs_review`, not deleted.
3. The user must be able to correct ingredient name, quantity, unit, package size, section, and inclusion before staging the import job.
4. Only the server may convert the corrected draft into an `ImportRecipePayload`.
5. The existing confirmed-import path remains strict, org-scoped, and human-confirmed.

The current route collapses two different states into one: "AI extracted a draft" and "server staged an importable recipe job." That is the core architectural problem. For a marketing-grade feature, these must become separate states:

1. **Extracted photo draft:** raw, editable, line-complete, may contain unresolved fields.
2. **Staged import job:** server-validated, canonical, ready for ingredient resolution and confirm.
3. **Committed recipe:** created only after the existing mandatory confirm.

---

## 2. Code-Grounded Root Cause

Verified against the current code in `PrepProfit-main (29).zip`.

| ID | Defect | Current behavior | Product impact | Required fix |
|---|---|---|---|---|
| RC-1 | Unit vocabulary is too narrow | `lib/units/token.ts` accepts only `g, kg, oz, lb, ml, l, floz, cup, count` plus a small alias set. It does not accept `tsp`, `teaspoon`, `tbsp`, `tablespoon`, or package descriptors. | Common recipes lose core lines. Baklava dropped butter, nuts, honey, cinnamon, etc. | Add true cooking units and a separate descriptor/package path. |
| RC-2 | Mapper silently removes unresolved lines | `lib/ai/map-extraction.ts` pushes an issue, then returns before adding the line when quantity is null or unit is unknown. | The user sees a confidently incomplete recipe. Silent data loss is worse than a visible correction. | Photo extraction must preserve unresolved lines in a draft review model. |
| RC-3 | The staged payload cannot represent unresolved photo lines | `ImportRecipePayload` only carries canonical, importable lines. | The photo UI cannot show "we read this, but need your help." | Introduce a photo-specific editable draft contract before creating `ImportRecipePayload`. |
| RC-4 | Review UI is mostly read-only | `photo-workbench.tsx` reuses `RecipeResolutionPanel` and `RecipeGrid`; it only lets the user choose fuzzy ingredient links. | A chef cannot fix the AI's name/quantity/unit/section mistakes. | Build a photo review workbench with editable fields and per-line status. |
| RC-5 | Display loses the chef's original unit | `RecipeGrid` renders canonical quantities through `formatQuantity`, so `1/2 cup` becomes `118 ml`. | Correct extraction looks wrong, which destroys trust. | Preserve entry quantity/unit for review display; canonical values remain server-side storage. |
| RC-6 | Sections are not first-class | Sections can only be lost or smuggled into ingredient names. | "Water [Syrup]" will not resolve cleanly and makes the recipe look amateur. | Capture `section` per line for review grouping; flatten only at final recipe storage for v1. |
| RC-7 | Tests currently lock in the bad behavior | `lib/ai/map-extraction.test.ts` asserts that unknown units/null quantities are dropped. | The exact Baklava failure can pass CI. | Replace those assertions with "visible as needs_review" regression tests. |
| RC-8 | Quality is not measured | There is no live eval set, no line-recall metric, and no launch gate. | Prompt/model changes are guesswork. | Add deterministic golden fixtures plus a manual live eval harness. |

The existing security and operations work is directionally good and should be preserved: manager gate, rate limit, quota reservation, ephemeral images, MIME validation by bytes, Zod validation, no automatic writes, `withOrg`/RLS, audit metadata, retry/backoff for provider overload, and `AI_EXTRACTION_BUSY`.

---

## 3. Product Promise

The user-facing promise should be:

> Take a photo of a recipe. PrepProfit reads it into a complete draft, highlights anything uncertain, lets you fix it in one screen, then creates the recipe only after you confirm.

This promise has two non-negotiables:

1. **Completeness beats false confidence.** A rough line with a warning is acceptable. A missing line is not.
2. **Correction must be faster than manual entry.** If the user has to retype the recipe because the app hid half of it, the feature failed.

---

## 4. Target Architecture

### 4.1 Extraction route returns an editable draft, not a final import job

Change the photo extraction success response from "already staged import job" to "editable photo draft."

Recommended shape:

```ts
type PhotoExtractionDraft = {
  attemptId: string;
  recipe: {
    name: string;
    yieldPortions: number | null;
    preparationNotes: string | null;
    lines: PhotoDraftLine[];
  };
  qualityFlags: AiQualityFlag[];
  usage: {
    provider: string;
    model: string;
  };
};

type PhotoDraftLine = {
  id: string;
  rawText: string | null;
  section: string | null;
  ingredientName: string;
  quantityText: string | null;
  quantityValue: number | null;
  unitToken: string | null;
  packageSizeValue: number | null;
  packageSizeUnitToken: string | null;
  confidence: number;
  status: 'ready' | 'needs_review' | 'ignored';
  issues: PhotoDraftIssue[];
};
```

Important details:

- `attemptId` is org-scoped and validated server-side on every follow-up request.
- `rawText` is for review only; do not log it in observability/audit.
- `status: ignored` is for crossed-out lines or lines the user explicitly removes.
- `status: needs_review` blocks staging until the user fixes the line or explicitly ignores it.
- The server still discards image bytes immediately. The UI can show a local preview from the selected file via an object URL; no server-side image retention is required.

### 4.2 New stage step converts the edited draft to an import job

Add a server-side stage endpoint/action, for example:

```txt
POST /api/recipes/import/photo/stage
```

Input: `attemptId` plus the edited `PhotoExtractionDraft` fields.  
Output: the current `PhotoExtractionPreview` shape with `jobId`, `recipePayload`, `issues`, `counts`, and `qualityFlags`.

The stage step must:

1. Load and validate the extraction attempt under `withOrg`.
2. Reject attempts from another org/user context.
3. Validate edited fields with strict Zod schemas and length limits.
4. Convert only active, resolved lines into `DraftRecipeLine`.
5. Run `planRecipeImport` server-side.
6. Create the `recipe_photo` import job.
7. Link the attempt to the job, or add a small `linkAttemptToImportJob` helper if `markAttemptSucceeded` is kept as extraction-only.
8. Return the same resolution payload the confirm flow already expects.

The confirm step should remain the existing `confirmImportAction` path.

### 4.3 Attempt lifecycle

Current schema allows `ai_extraction_attempts.import_job_id` to be null. Use that.

Recommended lifecycle:

1. `pending`: created before provider call, as today.
2. `succeeded` with `importJobId: null`: provider succeeded and returned an editable draft.
3. `succeeded` with `importJobId`: user staged the corrected draft into an import job.
4. `failed`: provider/validation failure.

Monthly quota should count provider-successful attempts even if the user abandons before staging, because the provider cost was spent. Do not keep successful abandoned attempts as `pending`.

---

## 5. Unit and Quantity Design

### 5.1 Add true cooking volume units

Add true measurable cooking units to the shared unit system:

| Token | Canonical unit | Factor |
|---|---|---|
| `tsp`, `teaspoon`, `teaspoons` | volume | 4.92892159375 ml |
| `tbsp`, `tablespoon`, `tablespoons` | volume | 14.78676478125 ml |

Update:

- `lib/units/index.ts`
- `lib/units/token.ts`
- `tests/import-recipes-parse.test.ts`
- `lib/ai/map-extraction.test.ts`
- any unit labels/dropdowns that assume the current `Unit` union is exhaustive

Do not rely on Gemini to normalize these. The deterministic parser must accept them.

### 5.2 Do not force package descriptors into the canonical `Unit` model

Tokens like `pkt`, `packet`, `bag`, `box`, `block`, `can`, `bunch`, `clove`, `slice`, `sprig`, and `pinch` are not all physical units. They are entry descriptors. Treating all of them as canonical `count` would create bad costs and dimension mismatches, especially for ingredients normally priced by weight or volume.

Recommended parser result:

```ts
type RecipeUnitParseResult =
  | { kind: 'canonical'; unit: Unit }
  | { kind: 'descriptor'; descriptor: string; impliedDimension: 'count' }
  | { kind: 'unknown'; code: 'INVALID_UNIT' };
```

Rules:

- True units (`g`, `kg`, `ml`, `cup`, `tsp`, `tbsp`) produce canonical quantity immediately.
- Descriptor with package size (`1 pkt walnuts (300g)`) should canonicalize from the package size (`300 g`) and preserve the descriptor for display.
- Descriptor without package size (`1 block butter`) remains `needs_review` unless it can resolve to a known supplier pack in a later phase.
- Count descriptors that are naturally countable (`2 eggs`, `2 cinnamon sticks`, `3 cloves garlic`) can be count lines, but preserve the display token so the review UI says `3 cloves`, not just `3`.
- Unknown tokens must never remove the line from the photo draft.

### 5.3 Preserve original entry display

Add review-only display fields:

- `quantityText`: e.g. `1/2`, `1 1/2`, `½`
- `unitToken`: e.g. `cup`, `tbsp`, `pkt`
- `displayText`: optional derived label such as `1/2 cup`

The stored recipe line can still use canonical `quantityCanonical` and `dimension`. The review UI should show the chef's original unit by default and optionally show canonical details only in a tooltip or secondary text.

### 5.4 Fractions

Do not depend only on the model's decimal conversion. Capture both raw and numeric forms:

- Prompt asks for `quantityText` exactly as written and `quantityValue` as a number when possible.
- Server accepts common ASCII and Unicode fractions: `1/2`, `1 1/2`, `½`, `¼`, `¾`, etc.
- If numeric conversion fails, keep the line visible as `needs_review`.

---

## 6. Prompt and Schema Changes

Update `lib/ai/recipe-extraction.ts` so the model returns richer line data:

```ts
{
  rawText: string | null;
  section: string | null;
  name: string;
  quantityText: string | null;
  quantityValue: number | null;
  unit: string | null;
  packageSizeValue: number | null;
  packageSizeUnit: string | null;
  crossedOut: boolean;
  confidence: number;
}
```

Prompt requirements:

- Extract every active ingredient line.
- Ignore clearly crossed-out lines for import, but return them as `crossedOut: true` if visible enough to explain why they were ignored.
- Preserve section labels such as `Syrup`, `Filling`, `Dough`, `Sauce`.
- Preserve raw units exactly as written.
- Capture parenthetical package sizes separately: `1 pkt walnuts (300g)` -> quantity `1`, unit `pkt`, package size `300 g`.
- Return `quantityText` exactly as written and `quantityValue` when it can be parsed confidently.
- Never invent missing values.
- Include one few-shot example with a handwritten, sectioned recipe and package-size lines.

Keep strict Zod validation and the Gemini structured response schema adjacent to each other so they cannot drift.

Do not make model escalation the first fix. A stronger model can improve OCR, but it will not fix a mapper/review contract that deletes unresolved lines.

---

## 7. Photo Review Workbench

Replace the read-only photo preview with an actual correction workbench.

Minimum required UI:

- Show the selected photo beside the extracted lines on desktop; stack photo above lines on mobile.
- Editable recipe name and yield.
- Group lines by `section`.
- Per-line editable fields: include/delete, ingredient name, quantity, unit, package size, section.
- Unit control includes canonical units plus descriptor tokens.
- Inline status: ready, needs review, ignored.
- "Add line" for ingredients the AI missed.
- "Restore ignored line" for crossed-out or user-deleted lines until staging.
- Confirm/stage button disabled until every active line is either ready or explicitly ignored.
- After staging, show the existing ingredient-resolution panel and recipe grid.

Important copy change:

- Current i18n says ambiguous/missing lines were "left out." That should become "needs review" once this plan is implemented.

Do not send edited rows directly to `confirmImportAction`. Edited rows must go to the new stage endpoint/action first, where the server validates and creates the import job.

---

## 8. Implementation Phases

### Phase 0 - Lock the Regression Before Fixing

Add red tests that reproduce the Baklava failure.

Required deterministic tests:

- `lib/ai/map-extraction.test.ts`: unknown unit and null quantity no longer disappear; they become `needs_review` draft lines.
- Baklava fixture: all 11 active ingredient lines are visible in the photo draft; the crossed-out line is ignored or shown as ignored, never imported.
- `tsp`/`tbsp` aliases parse to volume.
- `1/2 cup`, `1 1/2 cup`, and Unicode fractions parse correctly.
- Section values are preserved and do not get appended to ingredient names.
- Package-size line `1 pkt walnuts (300g)` preserves `pkt` for display and canonicalizes from `300 g`.
- Descriptor without package size remains visible as `needs_review`.

This phase should fail on current code.

### Phase 1 - Unit Parser and Photo Draft Contract

Build the photo draft types and deterministic normalization functions.

Affected areas:

- `lib/ai/types.ts`
- `lib/ai/map-extraction.ts`
- `lib/ai/recipe-extraction.ts`
- `lib/units/index.ts`
- `lib/units/token.ts`
- `lib/import/types.ts` only if a shared issue code is truly needed

Deliverables:

- `mapExtractedRecipe` no longer returns only `DraftRecipe[]`; either rename it or split it:
  - `mapExtractionToPhotoDraft`
  - `normalizePhotoDraftForImport`
- No extracted active line is lost.
- Import payload creation only happens after active lines are server-resolved.

### Phase 2 - Prompt and Schema Upgrade

Add `rawText`, `section`, `quantityText`, package-size fields, and `crossedOut`.

Deliverables:

- Zod schema and Gemini `responseSchema` updated together.
- Tests for `parseExtractionResponse`.
- Few-shot example included in prompt.
- Provider errors remain key-free and retry behavior remains unchanged.

### Phase 3 - Editable Review UI

Build the product surface that makes the feature trustworthy.

Affected areas:

- `app/(app)/recipes/import/photo/photo-workbench.tsx`
- `app/(app)/import/recipe-resolution.tsx` only after staging, not as the primary editor
- `lib/i18n/messages/*.json`

Deliverables:

- Local photo preview.
- Editable line table/cards.
- Section grouping.
- Add/delete/restore line.
- Clear unresolved status.
- Stage button blocked until active lines are valid.
- Responsive mobile layout tested.

### Phase 4 - Stage Edited Draft Server-Side

Add the server endpoint/action that turns edited draft into the existing import job.

Affected areas:

- New `app/api/recipes/import/photo/stage/route.ts` or server action
- `lib/data/ai-extraction.ts` helper to link attempt -> import job if needed
- `app/api/recipes/import/photo/route.ts` success response
- Existing `confirmImportAction` remains unchanged

Deliverables:

- Strict Zod validation for edited draft.
- Org/user ownership check on `attemptId`.
- `planRecipeImport` still runs inside `withOrg`.
- Audit logs still contain counts/metadata only, not raw recipe text or image bytes.
- Staged import job contains only canonical, validated, active lines.

### Phase 5 - Measurement and Launch Hardening

Add live eval and production observability.

Deliverables:

- `npm run eval:extraction` for manual/live provider eval, not CI.
- Gitignored real images or private fixture storage.
- Committed sanitized expected JSON and checksum/manifest.
- Metrics: line recall, correctable recall, field accuracy, hallucination rate, unresolved rate, provider latency, retry rate.
- Analytics events remain PII-free: counts, flags, model, latency bucket.

### Phase 6 - Supplier Pack Integration

Only after Phases 0-5 are stable, connect package descriptors to supplier packs.

Deliverables:

- Resolve `1 pkt phyllo`, `1 block butter`, `300g bag walnuts` against `ingredient_suppliers` pack metadata.
- Preserve `needsPricing` for anything without a trustworthy cost.
- Do not auto-price from AI text alone unless the pack match is exact and org-scoped.

---

## 9. Eval Plan

### 9.1 Metrics

Use these definitions:

- **Line recall:** active expected ingredient lines visible in the draft / active expected ingredient lines.
- **Correctable recall:** active expected lines visible either as ready or needs_review / active expected lines.
- **Ready accuracy:** ready lines whose name, quantity, unit, and section are correct without user edits.
- **Hallucination rate:** extra active lines not present in the source / extracted active lines.
- **Silent-loss rate:** expected active lines neither visible nor explicitly ignored. This must be 0.

### 9.2 Fixture set

Start with 20 photos:

- 5 handwritten recipes
- 5 printed/cookbook recipes
- 3 multi-section recipes
- 3 package-heavy recipes
- 2 low-light/blurry photos
- 2 non-English or mixed-language recipes

Baklava is mandatory and should stay in the eval set forever.

### 9.3 Launch thresholds

Before using this as the marketing hook:

- Silent-loss rate: **0** on the full eval set.
- Correctable recall: **>= 98%**.
- Line recall: **>= 95%**.
- Ready accuracy: **>= 85%**.
- Hallucination rate: **<= 2%**, and hallucinations must be easy to delete before staging.
- Baklava: **11/11 active lines visible**, honey/tbsp/cinnamon/packet/block lines handled, crossed-out line not imported.
- P95 extraction + first draft render: target **< 12 seconds** on normal image sizes.
- Mobile review can complete Baklava correction without horizontal overflow or hidden controls.

---

## 10. Acceptance Gates

### G1 - No Silent Data Loss

Every active line returned by the model is visible in the review UI as ready, needs_review, or ignored. No mapper branch may add an issue and then erase the line from the photo draft.

### G2 - Server-Side Trust Boundary

Client-edited draft data is treated as untrusted input. The server validates it, normalizes it, checks org ownership, runs `planRecipeImport`, and only then creates an import job.

### G3 - Existing Import Safety Still Holds

The final confirm path still:

- runs under `withOrg`/RLS,
- validates fuzzy link choices against stored suggestions,
- creates new ingredients at `priceCents = 0` and `needsPricing = true`,
- never auto-updates existing recipes or ingredients,
- stays idempotent for committed jobs.

### G4 - Review UX Is Actually Corrective

The user can correct all common AI/OCR failures without leaving the screen:

- ingredient name,
- quantity,
- unit,
- package size,
- section,
- missed line,
- hallucinated line.

### G5 - Eval Thresholds Pass

The metrics in section 9.3 pass on the eval set, including Baklava.

### G6 - Privacy and Observability Hold

No image bytes, raw OCR text, or full recipe text are logged to audit/analytics/observability. Stored attempt metadata remains limited to provider/model/status/token/cost/quality/count fields.

---

## 11. Risk Register

| Risk | Why it matters | Mitigation |
|---|---|---|
| Adding units breaks supplier/import assumptions | `Unit` is shared beyond AI extraction. | Add only true measurable units to `Unit`; keep descriptors in a separate photo/import-entry parser. |
| Editable client draft becomes a tampering vector | User can alter hidden fields or attempt ids. | Stage endpoint validates everything server-side under `withOrg`; never trust client canonical values blindly. |
| Image preview conflicts with ephemeral image policy | Users need to see the source photo while editing. | Use local browser object URL only; do not persist image server-side. |
| Prompt drift creates schema mismatch | Provider structured output is not a hard guarantee. | Keep Zod validation strict and tests for malformed responses. |
| Model escalation increases cost | Marketing hook can become expensive. | Escalate only after eval proves need; cap retries/escalations per extraction. |
| Package descriptors create fake costing | `1 pkt` without pack size is not enough to cost walnuts. | Mark unresolved or needs pricing until supplier pack resolution exists. |
| Read-only reuse looks faster to build | Current `RecipeGrid` is not a correction workflow. | Reuse it only after staging; build a photo-specific editor first. |

---

## 12. Recommended Build Order

1. Add red tests and Baklava fixture.
2. Add true cooking units and fraction parsing.
3. Introduce photo draft types and stop line loss in the mapper.
4. Upgrade prompt/schema to include raw text, sections, package size, and crossed-out state.
5. Build editable photo review UI with local image preview.
6. Add server-side stage endpoint/action.
7. Reuse existing ingredient resolution and confirm after staging.
8. Add live eval script and launch metrics.
9. Run eval, tune prompt/model only against measured failures.
10. Ship behind entitlement/feature availability only after gates pass.

Minimum marketing-ready scope is Phases 0-5 plus passing gates G1-G6. Unit parser fixes alone are not enough. A prompt-only fix is not enough. A model swap is not enough.

---

## 13. Non-Goals

- No provider/stack rewrite as part of the first fix.
- No automatic recipe creation from AI output.
- No automatic pricing from AI-extracted package text.
- No server-side image retention unless a separate, explicit support-retention feature is approved.
- No broad recipe-section data-model migration for v1; sections can be review-time grouping only.
- No weakening of org scoping, RBAC, quota, audit, or mandatory confirm.

---

## 14. Keep From Current Implementation

These parts are valuable and should not be regressed:

- Route handler for multipart upload.
- Node runtime for Gemini SDK and image processing.
- Manager-only access.
- Rate limit and monthly quota reservation.
- Image validation by bytes, not only MIME string.
- Ephemeral image handling.
- Strict Zod validation of model output.
- Provider retry/backoff for transient 429/5xx.
- Distinct `AI_EXTRACTION_BUSY` error for provider overload.
- `recipe_photo` jobs confirming through the existing import path after staging.
- Audit/analytics with metadata only.

---

## 15. Definition of Done

The feature is done when a real chef can photograph the Baklava recipe, see every active ingredient line, correct any uncertain fields in one screen, and create a complete recipe without hidden omissions.

For the Baklava regression specifically:

- phyllo pastry is visible,
- unsalted butter is visible,
- walnuts are visible,
- almonds are visible,
- sugar lines are visible and sectioned correctly,
- cinnamon is visible,
- cloves are visible as needs_review if quantity is absent,
- water is visible under Syrup,
- honey with `tbsp` is visible and parsed,
- cinnamon sticks are visible under Syrup,
- crossed-out text is not imported,
- no ingredient is hidden only because the unit vocabulary was incomplete.

That is the bar for a marketing hook.
