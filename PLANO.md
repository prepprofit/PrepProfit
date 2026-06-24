# PLANO.md - PrepProfit SaaS executable roadmap

This is the source of truth for sequencing work. Work one sprint at a time, in order.
Before starting any sprint, resolve the sprint decisions, get approval, then implement.
Mark tasks `[x]` only after code, tests, docs, and production notes are complete.

## Current Status

Completed product foundation:

- [x] Sprint 0 - multi-tenant foundation, Clerk org auth, Drizzle/Neon, RLS, app shell
- [x] Sprint 1 - ingredients, recipes, costing, units, inventory and low-stock alerts
- [x] Sprint 1.5 - trash/soft-delete foundation and 30-day purge route
- [x] Sprint 1.6 - recipe folders
- [x] Sprint 1.7 - hardening baseline: typed action errors, env validation, error boundaries, CI build
- [x] Sprint 2 - financials, transactions, dashboards, break-even, CSV export
- [x] Sprint 2.7 - global search with RBAC and pg_trgm
- [x] Sprint 3 - invoices and payroll data/builders, on-screen workflows, search registration

Deferred/resequenced:

- Sprint 2.5 import is intentionally moved to Sprint 4.5/4.6. Import must not ship before billing/limits and server-side staging are in place.
- AI/photo recipe extraction is intentionally Sprint 4.7. It depends on billing/usage limits, `import_jobs`, and the ingredient resolver.

Completed (continued):

- [x] Sprint 3.1 - production hardening: Postgres rate limiter, append-only audit log, recipe-line mutation hardening, real-Postgres concurrency proof
- [x] Sprint 3.5A - document foundation and invoice PDF (PDF route + print view, seller-identity settings, `@react-pdf/renderer`)
- [x] Sprint 3.5B - reports and Excel exports (recipe-card / P&L / payroll PDF + print, P&L + payroll XLSX via `write-excel-file`). Email split out to 3.5C.
- [x] Sprint 3.5C - document email (Resend): generate server-side, recipient validation, dedicated rate bucket, audit-after-accept, no cross-tenant attachments
- [x] Sprint 4 - billing, entitlements, and organization lifecycle (Clerk Billing + Stripe, `lib/entitlements.ts`, webhooks + `subscriptions` mirror, onboarding, org self-delete lockdown)
- [x] Sprint 4.5 - deterministic import foundation: ingredients and transactions (`import_jobs`, CSV/XLSX readers, staged preview/confirm)
- [x] Sprint 4.6 - recipe import and ingredient resolver (pure resolver, recipe parser/templates, staged resolution + confirm, migration 0017 `needs_pricing`)
- [x] Sprint 4.7 - AI photo recipe extraction (Gemini 3.5 Flash (Stable) behind an injectable/mockable wrapper, migration 0018 `ai_extraction_attempts`, staged `recipe_photo` job reusing the 4.6 confirm, monthly caps Pro 50 / Business 300, ephemeral images; prod migrated to 0018)

Completed (continued):

- [x] Sprint 5 - launch readiness and beta operations (sliced 5a-5g: Sentry observability, Playwright E2E smoke + Dependabot/`npm audit`, PostHog analytics, welcome + low-stock lifecycle emails, GDPR export + deletion-request + retention docs, a11y/mobile review, ops runbook + public landing page). Migration 0019 (5e). Next = Sprint 6 (kitchen tasks) unless beta feedback reprioritizes.

---

## Definition of Done - applies to every sprint

### Multi-tenancy and RLS

- Every business table has `organization_id`, is listed in `businessTables`, and receives RLS.
- Every select/insert/update/delete is explicitly org-scoped in the application layer.
- `organization_id` is always derived server-side from Clerk via `getOrgId()`; never from client input.
- Every write runs inside `withOrg(...)` unless the sprint explicitly documents a safe exception.
- Tests prove both app-layer isolation and RLS behavior. RLS tests must cover reads and writes: SELECT, INSERT `WITH CHECK`, UPDATE retag attempts, and DELETE reachability.

### Authorization and entitlements

- Role is derived from Clerk organization role only. `org:admin` maps to manager; everyone else is kitchen.
- Sensitive pages must render `NoAccess` for kitchen users.
- Sensitive Server Actions and Route Handlers must return `FORBIDDEN` before any data access.
- Manager-only surfaces: financials, transactions, break-even, invoices, payroll, trash, settings, reports, exports of sensitive data, billing, and generated documents.
- Dashboard exception: kitchen may see operational recipe/inventory widgets only if the sprint keeps this product decision explicit; financial widgets remain manager-only.
- Plan limits and paid-feature access are enforced on the server. UI hiding is never the control.

### Money, math, and data integrity

- Monetary values are integer cents. No float storage for money.
- Calculation logic lives in `lib/calculations/` and has tests for zero, negative, rounding, large values, NaN, and Infinity edges.
- Database constraints are added for important invariants when practical; app validation alone is not enough for money or lifecycle safety.
- Cross-tenant links are blocked at the DB layer with composite `(organization_id, foreign_id)` FKs.
- Soft-delete reads filter `deleted_at IS NULL`; purge paths preserve financial/history records by nulling optional links before deleting referenced rows.

### Validation, errors, observability, and abuse controls

- All user input is validated with Zod on the server.
- Action failures return a stable `ActionErrorCode` mapped through next-intl. No English error literals in action results.
- Unexpected failures go through `unexpected()` / `logError()` with an event id and useful context.
- New abuse-prone endpoints/actions use the rate limiter once Sprint 3.1 lands.
- High-risk mutations write audit log events once Sprint 3.1 lands.
- AI outputs are never trusted as final data. They become staged drafts with human review and server-side validation.

### i18n, types, UX, and tests

- UI strings go through next-intl. No hardcoded user-visible strings.
- No `any`, no `@ts-ignore`; types derive from Drizzle schema or explicit Zod schemas.
- Empty, loading, error, and forbidden states are honest and localized.
- Mobile at ~380px and keyboard-only usage must be checked for new user workflows.
- Green gate before merge: lint, typecheck, tests, and `next build`.
- Migrations: after generation, verify journal ordering; `scripts/migrate.ts` must abort on the silent-skip gotcha. Production deploy notes must name required env vars and migration verification.

---

## Sprint 3.1 - Production hardening before expansion

Goal: close correctness/security gaps before adding documents, import, billing, or heavier public surfaces.

Decisions locked:

- Use the existing Postgres/Neon stack for the first audit log and rate-limit buckets. Avoid a new infra dependency unless explicitly approved.
- Rate limiting is keyed by route/action plus user id/org id when authenticated; unauthenticated cron/webhook keys use a hashed request key, never raw secrets.
- Audit log is append-only, org-scoped, manager-readable later, but this sprint only writes events and tests isolation.

Tasks:

- [x] Fix the recipe-line active-row invariant under real Postgres concurrency. The `FOR UPDATE` locks in `addRecipeIngredient`, `deleteIngredientAction`/`trashIngredient`, and `restoreRecipeAction` shipped earlier (commit `1826001`); Sprint 3.1 adds the opt-in real-Postgres proof (`tests/concurrency/recipe-line.pg.test.ts`, gated by `TEST_DATABASE_URL`) since PGlite cannot prove concurrent `FOR UPDATE`.
- [x] Harden `updateRecipeIngredient` and `removeRecipeIngredient` so they only mutate lines attached to an active recipe in the same org (EXISTS guard on the active parent recipe + matching `recipeId`; a forged line id from a trashed/foreign recipe returns `NOT_FOUND`).
- [x] Add a small Postgres-backed rate limiter helper (`lib/rate-limit/`, atomic fixed-window, sha256 keys) and wire it to cron purge, transaction CSV export, and global search. Document/import/AI extension points are reserved buckets in `lib/rate-limit/config.ts`.
- [x] Add `audit_log` table: `organization_id`, `actor_user_id` (nullable), `actor_role` (incl. `system`), `action`, `entity_type`, `entity_id`, `metadata`, `created_at`, `request_id`. Append-only at the DB layer (RLS: SELECT + INSERT policies only).
- [x] Write audit events for financial mutations, invoice lifecycle changes, payroll mutations, trash restore/purge, settings changes, exports, and cron purge (`lib/data/audit.ts` + each action).
- [x] CSV formula neutralization (`=`, `+`, `-`, `@`, tab, CR) and low-stock-refuses-trashed regression tests already shipped earlier (`lib/finance/csv.test.ts`, `tests/inventory.test.ts`); not redone.
- [x] Sync repo docs: README roadmap, SETUP env/setup, CLAUDE rules, and this plan.

Acceptance criteria:

- The active recipe/ingredient invariant cannot be violated by normal actions, forged line ids, or documented concurrent flows.
- Abusable routes/actions have a tested limiter.
- High-risk changes leave audit events in the active org only.
- Documentation matches the actual product state and the next sprint is unambiguous.

---

## Sprint 3.5A - Document foundation and invoice PDF

Goal: build the document pipeline once, then ship the smallest high-value document: invoice print/PDF.

Decisions to lock before coding:

- PDF renderer: default to `@react-pdf/renderer` in Node runtime unless a proof-of-concept fails on Vercel.
- Invoice PDF and print are manager-only. Kitchen cannot generate or view invoice documents.
- Document generation uses Sprint 3.1 rate limiting and audit logging from day one.
- No email in this sprint. Email moves to Sprint 3.5B after PDF generation is stable.

Tasks:

- [x] Add shared document primitives: seller header, document metadata, money/date formatting, and safe text rendering (`lib/documents/`: `types.ts`, `format.ts`, `invoice-data.ts`, `invoice-labels.ts`). Seller identity (`business_*`) added to `organization_settings` (migration 0013).
- [x] Add invoice print view (`/invoices/[id]/print`) and invoice PDF route (`/api/invoices/[id]/pdf`). Both derive org id server-side, check manager role before data access, run inside `withOrg`, reuse the shared view-model, and use the frozen invoice totals.
- [x] Add document generation audit events (`export.invoicePdf`) and rate-limit checks (`documents` bucket, 20/min).
- [x] Add tests proving cross-org invoice ids return 404, kitchen cannot generate (403), totals reconcile with on-screen invoice data, and generated output is non-empty/valid PDF.
- [x] Add localized UI for print/download actions (`invoices.detail.print` / `downloadPdf`) and the seller-identity settings form.

Acceptance criteria:

- A manager can download and print a branded invoice PDF whose totals match the invoice screen.
- A kitchen user cannot reach the invoice document route/action.
- Cross-org invoice ids never leak existence or data.
- Rate limiting and audit logging are exercised by tests.

---

## Sprint 3.5B - Reports and Excel exports

Goal: extend the proven document pipeline to accountant/client-facing outputs without creating one-off renderers.

Decisions locked: XLSX via `write-excel-file` (Node); recipe-card is kitchen-allowed (the recipe editor already shows the same cost/margin to kitchen); email split to Sprint 3.5C; delivery order recipe-card -> P&L -> payroll.

Tasks:

- [x] Recipe card PDF/print: ingredients, quantities, cost breakdown, margin, and notes. Kitchen-allowed, org-scoped, rate-limited, audited (`export.recipeCardPdf`); trashed/cross-org id -> 404. (`lib/documents/recipe-card-*`, `/api/recipes/[id]/card/pdf`, `/recipes/[id]/card/print`)
- [x] P&L PDF/print for month/year, manager-only, reconciling with `/financials` via the shared `loadPlDocument`. Zod-validated period; audited (`export.plPdf`). (`lib/documents/pl-*`, `/api/financials/pl/pdf`, `/financials/print`)
- [x] Payroll period-summary PDF/print, manager-only and PII-safe (audit metadata is counts only, no names/per-person pay). Reconciles with `/payroll`. (`lib/documents/payroll-*`, `/api/payroll/summary/pdf`, `/payroll/print`)
- [x] XLSX export for P&L and payroll with number formats and formula-injection-safe text cells (shared `lib/documents/xlsx.ts` reusing `neutralizeFormula`). Audited (`export.plXlsx`, `export.payrollXlsx`).
- [>] Resend email action for generated documents -> moved to Sprint 3.5C.
- [>] Optional bulk download -> deferred (out of scope until single-document flows ship in prod).

Acceptance criteria:

- Invoice, recipe card, P&L, and payroll documents render consistently with shared branding. (done)
- P&L and payroll `.xlsx` files open in Excel with correct values and formatting. (done)
- Every report route follows RBAC -> rate-limit -> Zod -> withOrg load -> render -> post-success audit; cross-tenant data never leaks (tested). (done)

---

## Sprint 3.5C - Document email (Resend)

Goal: email a server-generated document to an allowed recipient, building on the 3.5B PDF/XLSX pipeline.

Decisions locked:

- Client sends only `documentType + entityId/period + recipient`; never PDF bytes, `organization_id`, or a document URL.
- Recipient validated with Zod; the server loads data via `getOrgId()` + `withOrg`, generates the document, and attaches it.
- Persistence: `audit_log` only (new `document.email` action) — no new table, no migration.
- Rate limiting: a dedicated, tighter `documentEmail` bucket (10/min) — outbound mail's abuse/cost/reputation risk differs from a local download.
- `RESEND_REPLY_TO`: added now, optional + lazy.
- Emailable document types this sprint: invoice, recipe card, P&L. Email is manager-only for all three (outbound send is sensitive, even though the recipe card download is kitchen-allowed).
- Payroll/payslip email is DEFERRED: emailing a payslip needs a per-employee PDF the pipeline doesn't have yet; the org-wide payroll summary would leak every employee's pay. Returns once a per-employee payslip PDF exists.

Tasks:

- [x] Add `RESEND_API_KEY` / `RESEND_FROM_EMAIL` (and optional `RESEND_REPLY_TO`) lazily in `lib/env.ts` (`emailEnv()`); document in SETUP.md + `.env.example`; never log the key.
- [x] Email action (`app/(app)/documents/email-actions.ts`): recipient Zod (`lib/validation/document-email.ts`), `documentEmail` rate bucket, generate document server-side via the shared `lib/documents/render.ts`, attach, send via the injected/mockable Resend client (`lib/email/resend.ts`).
- [x] Audit `document.email` only after the provider accepts (metadata = documentType + provider message id, no PII); Resend/config errors map to the stable `EMAIL_FAILED` code, technical details to `logError`.
- [>] Optional per-employee payslip PDF -> deferred with payroll/payslip email (see decision above).
- [x] Tests (`tests/document-email.test.ts`): provider mocked (never sends), invalid recipient, kitchen FORBIDDEN, rate limit, audit-after-accept (+ zero rows on failure), cross-tenant NOT_FOUND.

Acceptance criteria:

- Email sends a generated PDF to an allowed recipient, logs the event after acceptance, and never leaks another org's data or attaches another org's document. (done)

---

## Sprint 4 - Billing, entitlements, and organization lifecycle

Goal: paid plans are real controls, not UI decoration.

Decisions to lock before coding:

- Plan mapping remains: Starter = modules 1-3 and 50 recipes; Pro = modules 1-4 plus invoices; Business = all modules including payroll and advanced docs.
- Entitlements are checked with a central server helper. Do not scatter raw Clerk `has()` calls through actions.
- If entitlement state cannot be determined, deny paid features fail-closed.

Tasks:

- [x] Enable Clerk Billing for B2B organization plans and connect Stripe. (Slice 4a in dev; Stripe connected + catalogue live in PROD with `organization_enabled: true`.)
- [x] Create Starter / Pro / Business plans and features in Clerk. (Catalogue version-controlled at `clerk/billing.json`; identical slugs live in dev AND prod: plans `free_org`/`pro`/`business`, features `invoices`/`break_even`/`payroll`/`advanced_documents`/`ai_extraction`.)
- [x] Add `lib/entitlements.ts`: `requireFeature`, `canUseFeature`, `assertPlanLimit`. (Slice 4a — fail-closed over `auth().has()`.)
- [x] Add `/pricing` with Clerk PricingTable and an in-app billing/settings page. (Slice 4a — manager-only `/pricing` + `/billing`.)
- [x] Enforce Starter limits server-side: 1 user and 50 recipes. Imports and forged actions must not bypass limits. (Slice 4b — recipe cap via `assertPlanLimit`; feature gates via `requireFeature` after RBAC; 402 on download routes.)
- [x] Add post-signup onboarding: create org, choose plan, short setup tour. (Slice 4d — guided `/onboarding` flow: business-identity setup, plan selection via `<PricingTable>`, short module tour; gated once from `/dashboard` for a not-yet-onboarded manager via the set-once `organization_settings.onboarded_at` column, migration **0015**. Org defaults are also seeded eagerly on the `organization.created` webhook. PROD: run `npm run db:migrate` (0015) against prod Neon.)
- [x] Add verified Clerk/Stripe webhooks for subscription changes, member removal, and org lifecycle. (Slice 4c — `verifyWebhook` route `/api/webhooks/clerk` + `subscriptions` mirror, migration **0014** prod-applied. Remaining OPS only: create the PROD Svix endpoint `https://www.prepprofit.com/api/webhooks/clerk` and set `CLERK_WEBHOOK_SIGNING_SECRET` in Vercel — not a blocker; the mirror is read-only observability and eager-seed has lazy fallback.)
- [x] Add custom Owner role/lifecycle rules so customers cannot accidentally self-delete an org unless explicitly allowed. (Slice 4e — solved more simply than the original custom-role plan: Clerk's instance setting `organization_settings.admin_delete_enabled = false`, applied to BOTH dev AND prod, disables org self-deletion for all admins independent of role permissions. No system user / custom `org:owner` role needed.)
- [x] Add tests for entitlement bypass attempts, plan-limit races, forged webhooks, and fail-closed behavior. (Slices 4b/4c — `tests/entitlement-enforcement.test.ts`, RBAC-before-feature tests, forged-webhook 400 test.)

Acceptance criteria:

- A test org can subscribe to Pro and unlock Pro features.
- A Starter org cannot exceed server-enforced limits via direct action calls or imports.
- Forged webhooks are rejected.
- Entitlement failures do not leak paid or sensitive data.

---

## Sprint 4.5 - Deterministic import foundation: ingredients and transactions

Goal: import trusted structured files safely with server-side staging, preview, and idempotent confirm.

Decisions locked:

- Import requires a server-side `import_jobs` table. Preview state is never trusted from the client.
- First entities: ingredients and transactions. Recipe import is harder and moves to Sprint 4.6.
- Supported formats in v1: CSV and XLSX. `.docx` tables are considered in Sprint 4.6 only if still worth the dependency.
- No AI/OCR/free-form extraction in this sprint.

Schema:

- `import_jobs`: `organization_id`, `id`, `actor_user_id`, `entity`, `format`, `status` (`parsed`, `committed`, `expired`, `failed`), `source_filename`, `row_count`, `normalized_rows` JSON, `issues` JSON, `idempotency_key`, `expires_at`, timestamps.
- Add to `businessTables` and RLS. Jobs expire; confirmed jobs are immutable.

Tasks:

- [x] Template generator for ingredients and transactions. Columns match export/import docs exactly. (`lib/import/templates.ts`; transaction columns mirror `lib/finance/csv.ts`; round-trip tested.)
- [x] CSV/XLSX parsers that never evaluate formulas/macros and reject unknown sheets/columns. (`lib/import/csv.ts` dependency-free RFC-4180 reader; `lib/import/xlsx.ts` over `read-excel-file` — cached values only; unknown/missing/dup columns reject the file.)
- [x] Zod row schemas and `parseImport()` that returns typed normalized rows plus per-row issues. (`lib/validation/import.ts` + pure `lib/import/parse.ts` → draft rows + stable issue codes.)
- [x] Dry-run action: upload/parse/validate/plan rows, store `import_jobs`, return preview id. (`previewImportAction`; DB planning in `lib/data/import.ts` resolves categories/dedupe.)
- [x] Confirm action: load job by id inside `withOrg`, re-check role, apply rows in one transaction, mark committed with idempotency protection. (`confirmImportAction`; FOR UPDATE lock + status flip; Zod re-validation of stored records; all-or-nothing. NOTE: ingredients/transactions are Starter modules with no numeric cap, so no plan-limit gate here — the recipe cap applies in Sprint 4.6.)
- [x] UI: upload, entity/format selection, preview grid, per-row status, confirm, error handling, mobile usability, all localized. (`/import` manager-only page + `import-workbench.tsx`; `import.*` i18n.)
- [x] Tests: parser fixtures, formula/macro safety, unknown columns, row/file caps, locale money parsing, confirm idempotency, org isolation. (`import-csv`/`-xlsx`/`-parse`/`-templates`/`-data`/`-actions` suites.)

Acceptance criteria:

- Download a template, fill 10 ingredient rows, import, preview, confirm, and see rows created in the active org only.
- A transaction CSV exported by the app re-imports cleanly.
- A forged confirm payload cannot alter rows, bypass limits, or write outside the job's org.

Production note: ships migration **0016** (`import_jobs` table + RLS via `businessTables`). Run `npm run db:migrate` against prod after deploy. New `import` rate bucket (20/min per org+user) and `import.preview`/`import.commit` audit actions. The XLSX reader (`read-excel-file`) is externalized in `next.config.ts` (its `unzipper`→optional `@aws-sdk/client-s3` require must not be bundled). v1 scope: recipe links on transaction import are NOT restored (Sprint 4.6); category resolution matches the stored row name (locale-display names may not match — surfaced as `UNKNOWN_CATEGORY`).

---

## Sprint 4.6 - Recipe import and ingredient resolver

Goal: import recipes reliably by reusing the staging foundation and resolving ingredients with human confirmation.

Decisions to lock before coding:

- Recipe imports may create missing ingredients, but new ingredients default to `priceCents = 0` and are flagged as needing pricing.
- Fuzzy ingredient matches are suggestions, not automatic links.
- `.docx` table import is allowed only for real tables. Free-form prose remains Sprint 4.7/backlog depending on source.

Tasks:

- [x] `lib/import/resolveIngredient.ts`: exact, normalized, fuzzy, and new match outcomes, pure and tested. (Self-contained trigram Dice-coefficient resolver over a candidate list passed in by the data layer; normalizes case/accents/punctuation; auto-links only exact matches; fuzzy threshold 0.7, top 3 suggestions, never auto-linked.)
- [x] Recipe CSV/XLSX templates with recipe header rows and line rows, documented examples. (Long format — one row per ingredient line, grouped by `recipe`, columns `recipe, yield_portions, yield_percentage, ingredient, quantity, unit`; served by the existing template route; round-trip tested.)
- [x] Recipe import parser + row schemas + staged preview using `import_jobs`. (`parseRecipes` groups long-format rows case-insensitively, reads yield from each group's first row, validates quantity/unit, sums repeated lines per ingredient, flags `INVALID_UNIT`/`UNIT_MISMATCH`/`DUPLICATE_RECIPE`; `'recipes'` is a TS-only `import_jobs.entity` value — no migration.)
- [x] Preview UI for resolving fuzzy ingredient matches and confirming creation of new ingredients. (`import-workbench.tsx` resolution panel: exact auto-linked, new flagged for pricing, fuzzy offers a radio of suggestions + "create new" default; recipe grid shows yield + lines; choices travel to confirm as a validated JSON `resolutions` field.)
- [x] Confirm action creates/updates recipes and lines transactionally, re-checks recipe plan limits, and keeps cost honest for unpriced ingredients. (v1 only CREATES recipes; `confirmImportAction` validates resolutions against the stored suggestions (D8), re-checks linked ids are active org ingredients, enforces the recipe cap all-or-nothing (D7 → `PLAN_LIMIT_REACHED`), creates new ingredients at `priceCents 0` + `needs_pricing`, then recipes + lines via `addRecipeIngredient`; idempotent.)
- [>] Optional `.docx` table parser only if dependency and table extraction are proven in a spike. (Deferred — out of scope for v1; revisit in Sprint 4.7/backlog.)
- [x] Tests: exact/fuzzy/new resolver, unit conversion, unknown units, new unpriced ingredients, duplicate recipe handling, org isolation, and plan-limit races. (`resolveIngredient.test.ts`, `import-recipes-parse.test.ts`, `import-recipes-data.test.ts` (PGlite RLS read+write), `import-recipes-actions.test.ts` (RBAC, idempotency, forged resolution, plan cap, cross-org).)

Acceptance criteria:

- Import a recipe sheet referencing existing and new ingredients; existing ones link, new ones are staged as needing pricing, and recipe cost updates correctly once prices are filled. (done)
- Fuzzy matches require explicit user confirmation. (done — fuzzy defaults to "create new"; a link requires an explicit manager choice and is validated against the offered suggestions.)
- Confirm is idempotent and cannot write outside the active org. (done)

Production note: ships migration **0017** (`ingredients.needs_pricing boolean NOT NULL DEFAULT false`; additive — journal `when` 1781904288429 > 0016's 1781901704548, so the silent-skip gotcha does not apply). Run `npm run db:migrate` against prod Neon after deploy. No new env vars; reuses the Sprint 4.5 `import` rate bucket and `import.preview`/`import.commit` audit actions. New ingredients created by recipe import default to `priceCents 0` + `needs_pricing = true` and show a "Needs pricing" badge in `/ingredients`; setting a real price clears the flag.

---

## Sprint 4.7 - AI photo recipe extraction

Goal: let a chef photograph a recipe and turn it into a reviewed recipe draft, never an automatic write.

Why this lives here:

- It needs Sprint 4 billing/entitlements because every extraction has real provider cost.
- It needs Sprint 4.5 `import_jobs` because AI output must be staged server-side.
- It needs Sprint 4.6 ingredient resolver because extracted ingredient names must match existing org ingredients or stage new ones safely.

Decisions to lock before coding:

- Provider/model: choose in plan mode. Prefer a vision-capable model with structured JSON output. Hide provider behind `lib/ai/recipe-extraction.ts` so the app is not coupled to one SDK shape.
- Feature gate: Pro/Business only by default. Enforce server-side entitlement and monthly usage limits before accepting an image.
- Human review is mandatory. The feature creates an `import_job` / recipe draft preview; it never creates final recipes or ingredients directly from AI output.
- Image retention: default to short-lived processing only. Do not keep original images after extraction unless a manager explicitly opts in for support/debugging.
- Confidence: store and show per-field confidence/quality notes. Low-confidence fields must be visually flagged.
- Privacy: images may contain personal notes or customer data. Treat uploads as sensitive org data; log metadata, not image contents.

Schema/infra:

- Extend `import_jobs` or add `ai_extraction_attempts` linked to an import job:
  `organization_id`, `actor_user_id`, `provider`, `model`, `status`, `image_count`,
  `input_tokens`/cost metadata if available, `quality_flags`, `error_code`, timestamps.
- Add storage only if needed for short-lived upload handling. Prefer direct server processing and deletion.

Tasks:

- [x] Add image upload validation: MIME allowlist, file size cap, image count cap, basic dimension checks, and malware-safe handling. Reject PDFs and arbitrary files. (`lib/ai/image.ts` sniffs the REAL format from magic bytes — a renamed/spoofed PDF is rejected; 8 MB cap; min/max dimensions; 1 image in v1.)
- [x] Add AI extraction service wrapper that accepts image input and returns a strict Zod-validated structure. (`lib/ai/recipe-extraction.ts` — injectable Gemini 3.5 Flash (Stable) behind `RecipeExtractor`, structured JSON-schema output, model id pinned in one constant; `parseExtractionResponse` is the untrusted-input boundary; key via lazy `aiEnv()`, never logged.)
- [x] Normalize extracted units through `lib/units`; unknown/ambiguous units become row issues, never silent guesses. (Shared `lib/units/token.ts`, reused by the spreadsheet parser; `lib/ai/map-extraction.ts` maps to the 4.6 `DraftRecipe[]` shape.)
- [x] Run extracted ingredients through `resolveIngredient`: exact link, fuzzy suggestion, or staged new ingredient with `priceCents = 0` and `needs pricing`. (Reuses `planRecipeImport` unchanged.)
- [x] Store the extraction result in `import_jobs` (entity `recipe_photo`, format `photo`, status `parsed`); confirm reuses Sprint 4.6 `confirmImportAction`.
- [x] Build `/recipes/import/photo` UI: camera/upload on mobile, progress state, preview grid, image-quality warnings, ingredient match resolution, required confirmation. (Reuses the 4.6 resolution panel + recipe grid, extracted to `recipe-resolution.tsx`.)
- [x] Add rate limit (`aiExtraction` bucket), entitlement checks (`ai_extraction`, Pro/Business), monthly usage cap (Pro 50 / Business 300), audit events (`ai.extract` / `ai.extractFailed`), and provider error mapping to stable `ActionErrorCode`s (`AI_EXTRACTION_FAILED`, `USAGE_LIMIT_REACHED`). Migration 0018 = `ai_extraction_attempts` (org-scoped, RLS, observability + usage meter).
- [x] Add test fixtures with mocked AI output: good photo, blurry/incomplete photo, ambiguous units, hallucinated ingredient, duplicate ingredient, cross-org confirm attempt, usage-limit exceeded. (Provider always mocked, never called.)
- [x] Add observability for extraction success/failure/cost without logging raw recipe text. (`ai_extraction_attempts` stores provider/model/token/quality-flag metadata only; audit metadata is counts only.)

Acceptance criteria:

- A manager on an entitled plan uploads one recipe photo and receives a staged recipe draft with ingredient rows and match suggestions.
- The user must review and confirm before any recipe or ingredient is created.
- Ambiguous or low-confidence values are flagged and cannot silently become final data.
- New ingredients created from the draft are marked as needing pricing, so recipe cost stays honest.
- Kitchen users and non-entitled plans cannot run extraction; usage limits and rate limits block abuse.
- Cross-org job ids cannot be read or confirmed by another org.

Out of scope:

- Multi-page cookbook import.
- Automatic creation without review.
- OCR tuning for every handwriting style.
- Free-form text/doc extraction beyond recipe photos. Promote these only after v1 usage proves demand.

Production notes (deploy checklist):

- **Migration 0018** (`ai_extraction_attempts` + `import_jobs` unique `(organization_id, id)`): apply to prod Neon via `npm run db:migrate`. Journal `when` `1781946749470` > 0017's `1781904288429`, so the migrate-guard passes. The `recipe_photo` entity and `photo` job format are TS-only (no DB CHECK, confirmed by `db:generate`).
- **`GEMINI_API_KEY`**: set in Vercel (Production) — validated lazily by `aiEnv()`; a missing/invalid key surfaces as `AI_EXTRACTION_FAILED`, never crashes other pages. Never logged.
- **Model**: pinned in `RECIPE_EXTRACTION_MODEL` (`lib/ai/recipe-extraction.ts`); Gemini 3.5 Flash (Stable). Re-confirm the exact id at deploy; swapping is a one-line change.
- **Caps**: monthly usage is Pro 50 / Business 300 (`AI_EXTRACTION_MONTHLY_LIMIT` in `lib/entitlements.ts`) — tunable without redeploying the gating logic. The `aiExtraction` rate bucket is 5/min.

---

## Sprint 5 - Launch readiness and beta operations

Goal: first real customers can use the product with supportable operations.

Sliced into 5a-5g (each its own branch + gate + merge), recommended order
`5a -> 5b -> 5e -> 5d -> 5c -> 5f -> 5g`: 5a observability, 5b CI hardening
(E2E + dependency policy), 5c analytics, 5d lifecycle emails, 5e GDPR/data
lifecycle, 5f accessibility/mobile, 5g launch ops + landing page.

Tasks:

- [x] **Sprint 5a** - Sentry client/server integration, preserving current `logError`/`eventId` shape. `@sentry/nextjs` wired through the existing `lib/observability.ts` seam (forwards every `logError` with its `eventId`/`action` tags, org id as extra, no PII; `sendDefaultPii: false`). FAIL-OPEN: with no DSN, `Sentry.init` is a no-op and a forwarding failure can never escalate the original error (`captureException` is `try/catch`-guarded). Config files: `instrumentation.ts` (`register` + `onRequestError`), `sentry.server.config.ts`, `sentry.edge.config.ts`, `instrumentation-client.ts`; `next.config.ts` wrapped with `withSentryConfig` (source-map upload only when `SENTRY_AUTH_TOKEN`/org/project set, so CI/local builds stay green). New env (all optional): `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` (documented in SETUP.md + `.env.example`; never logged). Test: `lib/observability.test.ts` (eventId unchanged, forwards tagged, fail-open). Production note: set `SENTRY_DSN`/`NEXT_PUBLIC_SENTRY_DSN` (+ build-only `SENTRY_AUTH_TOKEN`/`SENTRY_ORG`/`SENTRY_PROJECT`) in Vercel; no migration.
- [x] **Sprint 5b** - Playwright E2E smoke + dependency policy. `@playwright/test` + `@clerk/testing`; `playwright.config.ts` (own `tests/e2e/*.spec.ts` dir, never collides with Vitest's `*.test.ts`); `tests/e2e/smoke.spec.ts` = always-on public smoke (landing + sign-in render/link) plus auth-gated manager-route + kitchen-RBAC specs that `test.skip` when the Clerk TEST instance + seeded users aren't configured (so a credential-less run still passes). CI gains an `npm audit --omit=dev --audit-level=high` step (prod deps, high/critical fail) and an opt-in `e2e` job gated on repo variable `RUN_E2E == 'true'` (skipped, never red, until secrets are set). `.github/dependabot.yml` = weekly grouped npm + actions updates. Production/ops note: to enable the authed E2E, set repo var `RUN_E2E=true` + secrets `E2E_CLERK_PUBLISHABLE_KEY`/`E2E_CLERK_SECRET_KEY` (Clerk TEST instance), `E2E_DATABASE_URL`, and `E2E_USER_EMAIL/PASSWORD` (+ optional `E2E_KITCHEN_*`). Mutating-flow coverage (create recipe/txn/invoice) deferred to a seeded-fixture follow-up — a reliable navigation+RBAC smoke is the launch gate's "one reliable E2E".
- [x] **Sprint 5c** - PostHog product analytics. Injectable `lib/analytics/` seam (mirrors the email seam): a CLOSED `AnalyticsEvent` allowlist (`recipe_created`, `invoice_issued`, `import_committed`, `recipe_photo_extracted`, `organization_onboarded`) with primitive-only, PII-free properties, and a `getAnalytics()`/`trackEvent()` that POST to PostHog's HTTP capture endpoint (no SDK, no flush lifecycle) with the org as a `$groups.organization` and a 2s timeout. FAIL-OPEN: no `POSTHOG_KEY` -> no-op (never calls fetch); `trackEvent` swallows every error so analytics can't break a request. Wired post-success into createRecipe / issueInvoice / confirmImport / photo-extract route / completeOnboarding. New optional env `POSTHOG_KEY` + `POSTHOG_HOST` (default us cloud; lazy `analyticsEnv()`, never logged; documented). Tests `lib/analytics/index.test.ts` (configured POST shape + group, org fallback distinct id, unconfigured no-op, fetch-failure fail-open). No migration. Server-side only (no client pageview SDK) for privacy/simplicity. Production note: set `POSTHOG_KEY` (+ optional `POSTHOG_HOST`) in Vercel to enable.
- [x] **Sprint 5d** - Lifecycle emails (welcome + low-stock). Reuses the Sprint 3.5C injectable `EmailSender` seam: `lib/email/notifications.ts` (`sendWelcomeEmail`, `sendLowStockEmail`, pure `lowStockSummaryLines`, HTML-escaped, copy in `notifications.*` i18n). **Welcome** is wired into the `organization.created` Clerk webhook — resolves the creating admin's email via `clerkClient`, BEST-EFFORT (guarded by new `isEmailConfigured()` so an unconfigured env skips quietly; fully try/caught + `logError` so it never 500s the webhook). **Low-stock digest** piggybacks on the daily purge cron: per org, when `businessEmail` is set and ingredients are at/below threshold (reuses `selectLowStock` + `listIngredients`), email a PII-free reorder list (also guarded + try/caught; adds `lowStockEmails` to the cron response). Tests `lib/email/notifications.test.ts` (line formatting, recipient, HTML-escape; provider faked). No new env (reuses `RESEND_*`); no migration. **Receipt + document-send-result emails DEFERRED** with rationale: the manual invoice document email (3.5C) already covers sending invoices, an auto-send-on-pay needs a customer-consent decision, and the document-send result is already returned synchronously by the 3.5C action.
- [x] **Sprint 5e** - GDPR/EU readiness: org data export, deletion-request workflow, retention docs. Manager-only `GET /api/account/export` (canonical RBAC 403 -> `accountExport` rate bucket 3/min 429 -> `withOrg` build -> post-success `account.export` audit) streams a JSON bundle of every business table via pure `lib/data/account-export.ts` (`buildOrgDataExport`, explicit `organization_id` filter + RLS; `rate_limits` excluded as infra). Deletion request is operator-fulfilled (org self-delete stays disabled, Sprint 4e): set-once-style columns `deletion_requested_at/by/reason` on `organization_settings` (migration **0019**, additive nullable — journal `when` 1781982276678 > 0018), data-layer `requestAccountDeletion`/`cancelAccountDeletion`/`readAccountDeletionState`, manager-only `requestAccountDeletionAction`/`cancelAccountDeletionAction` (audit `account.deletionRequest`/`account.deletionCancel`, metadata = `hasReason` only). UI: `/settings` "Data & privacy" card (export download + request/cancel form, `settings.privacy.*` i18n). Retention runbook `docs/data-retention.md` (per-category retention, Art. 15/20 export, Art. 17 erasure SOP, Neon PITR caveat). Tests `tests/account-export.test.ts` (export org-isolation A/B, deletion lifecycle leaves data intact, route 403/200+audit/429, action RBAC + PII-free audit). eslint config gained `argsIgnorePattern: '^_'` (intentional unused `useActionState` args). Production note: run `npm run db:migrate` (0019) against prod Neon; no new env vars; new `accountExport` rate bucket + `account.export`/`account.deletionRequest`/`account.deletionCancel` audit actions.
- [x] **Sprint 5f** - Accessibility & mobile review of core workflows at ~380px and keyboard-only. The app was already built to the design-taste/impeccable conventions, so this pass VERIFIED the key properties (mobile drawer `role=dialog`+aria-modal+Escape+scroll-lock+focus-restore; `aria-label` on every icon-only control + visible focus rings; `<Label htmlFor>` bound forms with `role=alert`/`status`; tables wrap in `overflow-x-auto`; ≥36px hit targets) and closed one concrete gap: the mobile nav drawer had no accessible name -> added `aria-label` (`topbar.menuTitle`). Findings + known limitations (no Tab focus-trap in the drawer; placeholder notifications bell; recommend axe in the E2E expansion) documented in `docs/accessibility.md`. No migration, no new deps.
- [x] **Sprint 5g** - Production operations runbook + public landing page. `docs/production-operations.md` = the ops runbook (Production env-var table, migration apply+verify SOP incl. the journal-`when` gotcha and current head 0019, purge-cron verification, Neon PITR/backup + erasure caveat, Clerk webhook, secret rotation, observability via `logError`+Sentry+`audit_log`, and a pre-launch checklist). Public landing (`app/(marketing)/page.tsx`) expanded from the hero into a full page — features grid (costing / financials & break-even / invoices·payroll·inventory / imports & AI), a CTA band, and a footer; all copy via the `marketing.*` i18n namespace, built on existing Card/Badge/Button primitives + lucide icons (root `overflow-x-hidden` so the taller page scrolls). The pricing CTA points to `/sign-up` (the in-app `<PricingTable>` at `/pricing` stays auth-gated). No migration, no new deps.

Acceptance criteria:

- Invite 3 beta chefs and have them complete onboarding without help.
- CI includes unit/integration gates and one reliable E2E smoke.
- A data-export request returns the org's data without cross-tenant leakage.

---

## Sprint 6 - Kitchen operations: prep, reorder, and checklist tasks

Goal: run kitchen work from reliable shared lists anchored in real PrepProfit data.

Product note:

- This is post-MVP expansion unless beta feedback proves tasks are needed for launch.
- Tasks are operational, not financial. Both manager and kitchen can read and complete tasks.

Tasks:

- [ ] `task_lists` and `tasks` tables, composite FKs, RLS, migration guard, isolation tests.
- [ ] Data layer and Server Actions for list/task CRUD, toggle, assign, reorder, reset, duplicate, soft-delete, restore, purge.
- [ ] Integrations: low-stock ingredient to reorder task; recipe to prep tasks.
- [ ] Extend trash/purge paths so purged recipes/ingredients null task source links first.
- [ ] Register tasks in global search for both roles.
- [ ] `/tasks` UI: list rail, task rows, status checkbox, assignee, due date, reorder, empty states, keyboard and mobile support.
- [ ] Tests for org isolation, RBAC, status toggle, assignment, reorder, soft-delete/restore, purge-null-link, reset/duplicate, integrations, and search registration.

Acceptance criteria:

- Create a prep list, add tasks, assign one, mark it done, and preserve order across reload.
- A low-stock ingredient can create a linked reorder task; purging the ingredient leaves the task intact with a null link.
- Kitchen can complete tasks but cannot create/delete lists or assign others.

---

## Done outside the numbered sprints

- **Recipe scaling/batch planning (DB-inert).** Resize an existing recipe live to a
  different batch (target-portions or anchor-ingredient mode) and read recalculated
  quantities. Derive-on-read only — NO migration, schema change, stored factor, or new
  dependency. Operational scaled prep card (money-free, both roles) at
  `/recipes/[id]/prep-card/{print,pdf}`; the existing manager-only cost sheet accepts an
  optional `?portions=`; scaled cost-sheet emails carry the same `portions`. Unit
  economics (cost/portion, price, margin) stay invariant; kitchen payload stays
  money-free by type. Pure math in `lib/calculations/recipeScale.ts`.

## Backlog - not scheduled until prioritized

- Advanced multi-image extraction, OCR tuning, handwriting-specific improvements, and free-form prose/doc import beyond Sprint 4.7.
- Duplicate-as-scaled-recipe (persisted scaling — Recipe scaling Phase 2).
- Suppliers as first-class entities with per-supplier price history.
- Saved reports and scheduled email summaries.
- True scheduled recurring checklists after Sprint 6 proves manual lists.
- Advanced audit-log UI for managers.
- Real Postgres concurrency test job for invoice numbering/import/stock beyond PGlite limits.
