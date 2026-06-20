# Sprint 4.7 — AI photo recipe extraction (PLAN)

Status: **draft plan, awaiting approval.** Branch to use: `feat/sprint-4.7-ai-extraction`.
Builds on Sprint 4.5 (`import_jobs` staging) and Sprint 4.6 (ingredient resolver +
staged recipe confirm). Read `PLANO.md` §"Sprint 4.7" and `CLAUDE.md` ("AI and import
rules", "Authorization", "Testing rules", Rule 1) before coding.

## 1. Goal & scope

Let a chef photograph a recipe and receive a **staged recipe draft** (never an
automatic write): photo → Gemini 3 Flash structured extraction → strict Zod
validation → unit normalization → `resolveIngredient` → an `ImportRecipePayload`
identical to Sprint 4.6, reviewed and confirmed by a human through the **same**
4.6 confirm path. AI output is untrusted input: staged, validated, human-confirmed.

**In scope**
- `lib/ai/recipe-extraction.ts` — provider wrapper (Gemini 3 Flash), injectable &
  mockable; returns a strict typed result with per-field confidence/quality flags.
- Image upload Route Handler: MIME allowlist, size/count/dimension caps, reject PDFs.
- Map extraction → `ImportRecipePayload` (reuse 4.6 `resolveIngredient`, `lib/units`,
  `planRecipeImport`-style resolution); store in a staged job; confirm reuses 4.6.
- Entitlement gate (`ai_extraction`, Pro/Business), **monthly usage cap**, rate limit,
  audit, stable `ActionErrorCode`s.
- `/recipes/import/photo` UI: camera/upload (mobile), progress, preview with
  confidence + image-quality warnings, ingredient resolution panel, mandatory confirm.

**Out of scope (defer / backlog)**
- Multi-page cookbook import; OCR tuning per handwriting style.
- Free-form prose/doc extraction beyond recipe photos.
- Automatic creation without review (forbidden by CLAUDE.md).
- Long-term image retention (ephemeral processing only in v1).

## 2. Decisions to confirm (recommendation each)

| # | Decision | Recommendation |
|---|----------|----------------|
| **D1** | **Provider / model.** | **DECIDED: Gemini 3 Flash** (`gemini-3-flash-preview`) behind `lib/ai/recipe-extraction.ts`, using **structured output** (a `responseSchema`/JSON schema) so the model returns typed recipe JSON in one call. Chosen for cheap single-call multimodal (~$0.004/photo), 1M context, strong vision ("Agentic Vision"). **Caveat: it is Preview** — pin the exact model id in one config constant, keep the provider behind the wrapper, and add a documented swap path (Gemini 2.5 Flash GA or a Claude vision model) if Preview is deprecated. API key via lazy `aiEnv()` (never logged). |
| D2 | **Schema / infra.** | `import_jobs.entity` gains a TS-only value **`'recipe_photo'`** (no migration — same as 4.6's `'recipes'`); its `normalized_rows` stores the SAME `ImportRecipePayload` (so confirm reuses `applyRecipeImport`). Add **migration 0018**: a new org-scoped, RLS'd `ai_extraction_attempts` table (links to the job) holding `provider`, `model`, `status`, `image_count`, `input_tokens`/`output_tokens`/cost metadata if available, `quality_flags` (jsonb), `error_code`, timestamps — for observability + the monthly usage count. Watch the journal `when` gotcha: must be **> 1781904288429** (0017's `when`). |
| D3 | **Image upload.** | A **Route Handler** (multipart) — file uploads need a route, not a Server Action (CLAUDE.md code rules). v1: **1 image** per extraction (cap configurable). MIME allowlist `image/jpeg|png|webp`; size cap **8 MB**; basic dimension sanity (min/max px); reject PDF and anything else. Strip to bytes only; never persist the file. RBAC + entitlement + rate-limit checked **before** reading the body. |
| D4 | **Entitlement + usage limits.** | `requireFeature('ai_extraction')` (Pro/Business; the feature already exists in `clerk/billing.json` + `lib/entitlements.ts`) AFTER the manager check (RBAC → entitlement). **Monthly cap** per tier via a new `AI_EXTRACTION_MONTHLY_LIMIT` map (e.g. Pro N, Business M); enforced by counting succeeded `ai_extraction_attempts` for the org in the current month inside the same `withOrg` tx. Dedicated rate bucket **`aiExtraction`** (tight, e.g. 5/min). New codes `AI_EXTRACTION_FAILED`, `USAGE_LIMIT_REACHED`. |
| D5 | **Image retention.** | **Ephemeral** — process the bytes in memory and discard; never store the original image. Persist only non-sensitive metadata (size, mime, dimensions, model, token/cost, quality flags) + the extracted structure (the staged job). Manager opt-in retention for support is **deferred**. Log metadata, never image contents (CLAUDE.md). |
| D6 | **Confidence / quality.** | The extraction schema asks Gemini for an **overall confidence** + a per-field/per-line note, and we derive `quality_flags` (e.g. `low_confidence`, `ambiguous_unit`, `unreadable_region`). Low-confidence fields are **visually flagged** in the preview and can never silently become final data; ambiguous units become row issues (reuse `INVALID_UNIT`/`UNIT_MISMATCH`), never silent guesses. |
| D7 | **Provider abstraction + testing.** | `lib/ai/recipe-extraction.ts` exposes `extractRecipeFromImage(bytes, mime)` → strict typed result; the concrete Gemini client is injected so tests **mock it and never call the real API**. The mapping (AI result → `ImportRecipePayload`) is a pure, separately-tested function. |
| D8 | **Output → staged mapping.** | Reuse 4.6: Zod-validate the AI JSON → normalize units via `lib/units` (unknown/ambiguous → issue, never guess) → `resolveIngredient` against active org ingredients (exact/fuzzy/new, fuzzy never auto-linked) → build `ImportRecipePayload`. New ingredients default `priceCents 0` + `needs_pricing`. Confirm = the unchanged 4.6 `confirmImportAction` path (recipe cap D7/D8 of 4.6 still apply). |
| D9 | **UI.** | New `/recipes/import/photo` (manager-only): mobile camera/upload, progress/loading, preview grid with confidence + image-quality warnings, the **reused 4.6 resolution panel**, and a required confirm. Distinct from `/import` (file workbench). All copy localized. |

## 3. Data model / migrations

- `import_jobs.entity` += `'recipe_photo'` — **TS-only** (drizzle text-enum emits no DB
  CHECK; same as 4.6's `'recipes'`). `normalized_rows` reuses `ImportRecipePayload`.
- **Migration 0018** — `ai_extraction_attempts` (org-scoped, in `businessTables`, standard
  `org_isolation` RLS; the webhook/cron pattern does not apply — it is written inside the
  authenticated action's `withOrg`). Columns: `id`, `organization_id`, `actor_user_id`,
  `import_job_id` (nullable until the job is staged), `provider`, `model`, `status`
  (`pending|succeeded|failed`), `image_count`, `input_tokens`, `output_tokens`,
  `cost_micros` (nullable), `quality_flags` jsonb, `error_code` (nullable), `created_at`.
  Journal `when` **> 1781904288429**.
- Env: `GEMINI_API_KEY` added lazily in `lib/env.ts` (`aiEnv()`), documented in
  `SETUP.md` + `.env.example`; never logged.

## 4. Implementation order (small conventional commits)

1. **Provider wrapper + types:** `lib/ai/recipe-extraction.ts` (injectable Gemini 3 Flash
   client, structured-output schema, strict typed result) + `aiEnv()`. Unit-test the
   PARSING/validation of a mocked provider response (never the network).
2. **Migration 0018 + `ai_extraction_attempts`** (D2): schema, `businessTables`, RLS,
   `db:generate`, fix journal `when`. Data-layer helpers (create attempt, mark
   succeeded/failed, count-this-month). PGlite RLS tests.
3. **Mapping (pure):** AI result → `ImportRecipePayload` reusing `resolveIngredient` +
   `lib/units` (unknown/ambiguous unit → issue; new ingredient → priceCents 0 +
   needs_pricing; per-field confidence → `quality_flags`). Pure tests with mocked AI
   fixtures (good / blurry / ambiguous unit / hallucinated / duplicate / low-confidence).
4. **Upload route + extract action** (D3/D4): Route Handler (multipart, caps, MIME
   allowlist) → RBAC → `requireFeature('ai_extraction')` → rate limit (`aiExtraction`) →
   monthly cap → extract → map → stage `import_jobs` (`recipe_photo`) → write
   `ai_extraction_attempts` + audit `ai.extract` (success) / `ai.extractFailed`. Stable
   codes `AI_EXTRACTION_FAILED`, `USAGE_LIMIT_REACHED`. Tests: RBAC/entitlement/cap/rate,
   provider error mapping, cross-org job isolation.
5. **Confirm reuse:** confirm the staged `recipe_photo` job via the **unchanged** 4.6
   `confirmImportAction` (validates resolutions, recipe cap, creates ingredients+recipes).
   Add a test proving the photo job confirms through the same path + idempotency + forged
   resolution rejected.
6. **UI:** `/recipes/import/photo` (mobile camera/upload, progress, confidence + quality
   warnings, reused resolution panel, mandatory confirm); localized `recipes.import.*`.
7. **Observability + docs:** success/failure/cost metrics without raw recipe text beyond
   the staged job; mark Sprint 4.7 `[x]` in `PLANO.md`; production notes (migration 0018,
   `GEMINI_API_KEY`, monthly caps). Update memory.
8. **Gate + ship:** `npm run lint && npm run typecheck && npm test && npm run build`;
   apply migration 0018 to prod Neon; **confirm with the user before merge**; ff → `main`.

## 5. Testing strategy (CLAUDE.md AI testing rules)

- **Provider mocked, never called.** Fixtures: good photo, blurry/incomplete, ambiguous
  units, hallucinated ingredient, duplicate ingredient, low confidence.
- **Mapping (pure):** AI result → payload; unknown/ambiguous unit → issue (no silent
  guess); new ingredient → priceCents 0 + needs_pricing; confidence → quality flags.
- **Entitlement/usage:** kitchen FORBIDDEN before data; non-entitled plan UPGRADE_REQUIRED;
  monthly cap → USAGE_LIMIT_REACHED; rate limit; all before reading the image.
- **RLS read+write:** `ai_extraction_attempts` + staged jobs org-isolated; cross-org job
  cannot be read or confirmed by another org.
- **Confirm:** idempotent; recipe plan-limit race; forged resolution rejected (reuses 4.6).
- **Image upload:** MIME/size/count/dimension rejects; PDF rejected; failure writes a
  `failed` attempt and no job.

## 6. Reuse from 4.5 / 4.6 (do NOT rebuild)

`import_jobs` + RLS + the staged preview→confirm skeleton; `ImportRecipePayload`,
`planRecipeImport`/`applyRecipeImport`/`buildResolvedChoices`, `confirmImportAction`
(`{jobId, resolutions}` + recipe cap); `lib/import/resolveIngredient.ts`; `lib/units`;
`needs_pricing`; `lib/entitlements` (`ai_extraction` feature already in `clerk/billing.json`);
`lib/rate-limit`; `lib/data/audit`; the 4.6 resolution-panel UI.

## 7. Acceptance criteria (from PLANO §4.7)

- A manager on an entitled plan uploads one recipe photo and receives a staged recipe
  draft with ingredient rows and match suggestions.
- The user must review and confirm before any recipe or ingredient is created.
- Ambiguous/low-confidence values are flagged and cannot silently become final data.
- New ingredients from the draft are marked as needing pricing (cost stays honest).
- Kitchen users and non-entitled plans cannot run extraction; usage + rate limits block abuse.
- Cross-org job ids cannot be read or confirmed by another org.

## 8. Open questions for the user before coding

- **Q1 (D3):** photos mostly **printed** or **handwritten**? (Sets whether 3 Flash single-call
  is enough or a fallback OCR is worth keeping in mind.) 1 image per extraction OK for v1?
- **Q2 (D4):** monthly extraction caps per tier — proposed Pro = e.g. 50/mo, Business = e.g.
  300/mo. Confirm the numbers.
- **Q3 (D1):** accept Gemini 3 Flash **Preview** in production with a pinned id + documented
  swap, or prefer starting on **Gemini 2.5 Flash GA** for stability and upgrade later?
