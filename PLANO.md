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

Next sprint:

- [ ] Sprint 3.5A - document foundation and invoice PDF

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

- [ ] Add shared document primitives: org header, document metadata, money/date formatting, page footer, and safe text rendering.
- [ ] Add invoice print view and invoice PDF route/action. Both derive org id server-side, check manager role before data access, run inside `withOrg`, and use existing invoice totals.
- [ ] Add document generation audit events and rate-limit checks.
- [ ] Add tests proving cross-org invoice ids return not found/forbidden, kitchen cannot generate, totals reconcile with on-screen invoice data, and generated output is non-empty/valid.
- [ ] Add localized UI for print/download actions and failure states.

Acceptance criteria:

- A manager can download and print a branded invoice PDF whose totals match the invoice screen.
- A kitchen user cannot reach the invoice document route/action.
- Cross-org invoice ids never leak existence or data.
- Rate limiting and audit logging are exercised by tests.

---

## Sprint 3.5B - Reports, Excel exports, and document email

Goal: extend the proven document pipeline to accountant/client-facing outputs without creating one-off renderers.

Tasks:

- [ ] Recipe card PDF/print: ingredients, quantities, cost breakdown, margin, and notes.
- [ ] P&L PDF/print for month/year, manager-only, reconciling with financial dashboard numbers.
- [ ] Payroll payslip/period summary PDF/print, manager-only and PII-safe.
- [ ] XLSX export for P&L and payroll with formatting and formula-injection-safe text cells.
- [ ] Resend email action for generated documents: recipient validation, rate limiting, audit log, clear delivery/error states, and no cross-tenant attachments.
- [ ] Optional bulk download only after the single-document flows are stable.

Acceptance criteria:

- Invoice, recipe card, P&L, and payroll documents render consistently with shared branding.
- P&L and payroll `.xlsx` files open in Excel with correct values and formatting.
- Email sends a generated PDF to an allowed recipient, logs the event, and never leaks another org's data.

---

## Sprint 4 - Billing, entitlements, and organization lifecycle

Goal: paid plans are real controls, not UI decoration.

Decisions to lock before coding:

- Plan mapping remains: Starter = modules 1-3 and 50 recipes; Pro = modules 1-4 plus invoices; Business = all modules including payroll and advanced docs.
- Entitlements are checked with a central server helper. Do not scatter raw Clerk `has()` calls through actions.
- If entitlement state cannot be determined, deny paid features fail-closed.

Tasks:

- [ ] Enable Clerk Billing for B2B organization plans and connect Stripe.
- [ ] Create Starter / Pro / Business plans and features in Clerk.
- [ ] Add `lib/entitlements.ts`: `requireFeature`, `canUseFeature`, `assertPlanLimit`.
- [ ] Add `/pricing` with Clerk PricingTable and an in-app billing/settings page.
- [ ] Enforce Starter limits server-side: 1 user and 50 recipes. Imports and forged actions must not bypass limits.
- [ ] Add post-signup onboarding: create org, choose plan, short setup tour.
- [ ] Add verified Clerk/Stripe webhooks for subscription changes, member removal, and org lifecycle.
- [ ] Add custom Owner role/lifecycle rules so customers cannot accidentally self-delete an org unless explicitly allowed.
- [ ] Add tests for entitlement bypass attempts, plan-limit races, forged webhooks, and fail-closed behavior.

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

- [ ] Template generator for ingredients and transactions. Columns match export/import docs exactly.
- [ ] CSV/XLSX parsers that never evaluate formulas/macros and reject unknown sheets/columns.
- [ ] Zod row schemas and `parseImport()` that returns typed normalized rows plus per-row issues.
- [ ] Dry-run action: upload/parse/validate/plan rows, store `import_jobs`, return preview id.
- [ ] Confirm action: load job by id inside `withOrg`, re-check role and plan limits, apply rows in one transaction, mark committed with idempotency protection.
- [ ] UI: upload, entity/format selection, preview grid, per-row status, confirm, error handling, mobile usability, all localized.
- [ ] Tests: parser fixtures, formula/macro safety, unknown columns, row/file caps, locale money parsing, confirm idempotency, org isolation, and plan-limit enforcement.

Acceptance criteria:

- Download a template, fill 10 ingredient rows, import, preview, confirm, and see rows created in the active org only.
- A transaction CSV exported by the app re-imports cleanly.
- A forged confirm payload cannot alter rows, bypass limits, or write outside the job's org.

---

## Sprint 4.6 - Recipe import and ingredient resolver

Goal: import recipes reliably by reusing the staging foundation and resolving ingredients with human confirmation.

Decisions to lock before coding:

- Recipe imports may create missing ingredients, but new ingredients default to `priceCents = 0` and are flagged as needing pricing.
- Fuzzy ingredient matches are suggestions, not automatic links.
- `.docx` table import is allowed only for real tables. Free-form prose remains Sprint 4.7/backlog depending on source.

Tasks:

- [ ] `lib/import/resolveIngredient.ts`: exact, normalized, fuzzy, and new match outcomes, pure and tested.
- [ ] Recipe CSV/XLSX templates with recipe header rows and line rows, documented examples.
- [ ] Recipe import parser + row schemas + staged preview using `import_jobs`.
- [ ] Preview UI for resolving fuzzy ingredient matches and confirming creation of new ingredients.
- [ ] Confirm action creates/updates recipes and lines transactionally, re-checks recipe plan limits, and keeps cost honest for unpriced ingredients.
- [ ] Optional `.docx` table parser only if dependency and table extraction are proven in a spike.
- [ ] Tests: exact/fuzzy/new resolver, unit conversion, unknown units, new unpriced ingredients, duplicate recipe handling, org isolation, and plan-limit races.

Acceptance criteria:

- Import a recipe sheet referencing existing and new ingredients; existing ones link, new ones are staged as needing pricing, and recipe cost updates correctly once prices are filled.
- Fuzzy matches require explicit user confirmation.
- Confirm is idempotent and cannot write outside the active org.

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

- [ ] Add image upload validation: MIME allowlist, file size cap, image count cap, basic dimension checks, and malware-safe handling. Reject PDFs and arbitrary files in this sprint.
- [ ] Add AI extraction service wrapper that accepts image input and returns a strict Zod-validated structure: recipe name, yield/portions, ingredient lines, quantities, units, preparation notes, warnings, and confidence per field.
- [ ] Normalize extracted units through `lib/units`; unknown/ambiguous units become row issues, never silent guesses.
- [ ] Run extracted ingredients through `resolveIngredient`: exact link, fuzzy suggestion, or staged new ingredient with `priceCents = 0` and `needs pricing`.
- [ ] Store the extraction result in `import_jobs` with status `parsed`; confirm reuses Sprint 4.6 recipe import confirm path.
- [ ] Build `/recipes/import/photo` UI: camera/upload on mobile, progress state, preview grid, image-quality warnings, ingredient match resolution, required confirmation.
- [ ] Add rate limit, entitlement checks, monthly usage cap, audit events, and provider error mapping to stable `ActionErrorCode`s.
- [ ] Add test fixtures with mocked AI output: good photo, blurry/incomplete photo, ambiguous units, hallucinated ingredient, duplicate ingredient, cross-org confirm attempt, usage-limit exceeded.
- [ ] Add observability for extraction success/failure/cost without logging raw recipe text beyond normal org-scoped import job data.

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

---

## Sprint 5 - Launch readiness and beta operations

Goal: first real customers can use the product with supportable operations.

Tasks:

- [ ] Sentry client/server integration, preserving current `logError`/`eventId` shape.
- [ ] Playwright E2E smoke in CI: sign in, create recipe, enter transaction, view dashboard, create invoice, and verify kitchen RBAC blocks sensitive routes.
- [ ] Dependency maintenance: Dependabot/Renovate and `npm audit` policy in CI.
- [ ] PostHog or equivalent product analytics for key events, with no sensitive payloads.
- [ ] Lifecycle emails: welcome, receipt, low-stock alert, document send result.
- [ ] GDPR/EU readiness: org data export, deletion request workflow, retention docs for trash, audit log, invoices, payroll PII, imports, and AI extraction metadata.
- [ ] Accessibility and mobile review of core workflows at ~380px.
- [ ] Production operations checklist: env vars, domain, Neon backups/PITR, Vercel cron, status page, secret rotation, migration verification runbook.
- [ ] Public landing page and pricing CTA only after billing is functional.

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

## Backlog - not scheduled until prioritized

- Advanced multi-image extraction, OCR tuning, handwriting-specific improvements, and free-form prose/doc import beyond Sprint 4.7.
- Recipe scaling/batch planning.
- Suppliers as first-class entities with per-supplier price history.
- Saved reports and scheduled email summaries.
- True scheduled recurring checklists after Sprint 6 proves manual lists.
- Advanced audit-log UI for managers.
- Real Postgres concurrency test job for invoice numbering/import/stock beyond PGlite limits.
