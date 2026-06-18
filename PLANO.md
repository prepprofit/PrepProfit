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

Next sprint:

- [ ] Sprint 3.1 - production hardening before documents/import/billing expansion

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

### Validation, errors, and observability

- All user input is validated with Zod on the server.
- Action failures return a stable `ActionErrorCode` mapped through next-intl. No English error literals in action results.
- Unexpected failures go through `unexpected()` / `logError()` with an event id and useful context.
- New abuse-prone endpoints/actions use the rate limiter once Sprint 3.1 lands.
- High-risk mutations write audit log events once Sprint 3.1 lands.

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

- [ ] Fix the recipe-line active-row invariant under real Postgres concurrency.
      Lock the recipe and ingredient rows involved in `addRecipeIngredient`, lock/serialize
      `deleteIngredientAction`, and lock/serialize `restoreRecipeAction` so an active recipe
      cannot end up referencing a trashed ingredient. Add tests for normal guards and document
      any PGlite concurrency limitation.
- [ ] Harden `updateRecipeIngredient` and `removeRecipeIngredient` so they only mutate lines
      attached to an active recipe in the same org; forged line ids from a trashed recipe must
      return `NOT_FOUND`.
- [ ] Add a small Postgres-backed rate limiter helper and wire it to cron purge, transaction CSV
      export, global search, and future document/import extension points. Add tests for allow,
      block, window reset, and org isolation where applicable.
- [ ] Add `audit_log` table: `organization_id`, `actor_user_id`, `actor_role`, `action`,
      `entity_type`, `entity_id`, `metadata`, `created_at`, `request_id`. Add it to
      `businessTables` and test RLS read/write isolation.
- [ ] Write audit events for financial mutations, invoice lifecycle changes, payroll mutations,
      trash restore/purge, settings changes, exports, cron purge, and future document/import hooks.
- [ ] Add regression tests for CSV formula neutralization (`=`, `+`, `-`, `@`, tab, CR) and for
      low-stock threshold refusing trashed ingredients.
- [ ] Sync repo docs: README roadmap, SETUP env/setup, CLAUDE rules, and this plan.

Acceptance criteria:

- The active recipe/ingredient invariant cannot be violated by normal actions, forged line ids,
  or documented concurrent flows.
- Abusable routes/actions have a tested limiter.
- High-risk changes leave audit events in the active org only.
- Documentation matches the actual product state and the next sprint is unambiguous.

Production note:

- Run migrations in production and verify `audit_log` and rate-limit tables exist and have RLS.

---

## Sprint 3.5A - Document foundation and invoice PDF

Goal: build the document pipeline once, then ship the smallest high-value document: invoice print/PDF.

Decisions to lock before coding:

- PDF renderer: default to `@react-pdf/renderer` in Node runtime unless a proof-of-concept fails on Vercel. Do not add browser automation for PDF generation without approval.
- Invoice PDF and print are manager-only. Kitchen cannot generate or view invoice documents.
- Document generation uses Sprint 3.1 rate limiting and audit logging from day one.
- No email in this sprint. Email moves to Sprint 3.5B after PDF generation is stable.

Tasks:

- [ ] Add shared document primitives: org header, document metadata, money/date formatting,
      page footer, and safe text rendering. No duplicated per-document layout logic.
- [ ] Add invoice print view and invoice PDF route/action. Both derive org id server-side,
      check manager role before data access, run inside `withOrg`, and use existing invoice totals.
- [ ] Add document generation audit events and rate-limit checks.
- [ ] Add tests proving cross-org invoice ids return not found/forbidden, kitchen cannot generate,
      totals reconcile with on-screen invoice data, and generated output is non-empty/valid.
- [ ] Add localized UI for print/download actions and failure states.

Acceptance criteria:

- A manager can download and print a branded invoice PDF whose totals match the invoice screen.
- A kitchen user cannot reach the invoice document route/action.
- Cross-org invoice ids never leak existence or data.
- Rate limiting and audit logging are exercised by tests.

---

## Sprint 3.5B - Reports, Excel exports, and document email

Goal: extend the proven document pipeline to accountant/client-facing outputs without creating one-off renderers.

Decisions to lock before coding:

- Email provider: Resend, with a thin `lib/email` client and testable send abstraction.
- Excel generation: use a real `.xlsx` writer with typed number/date/currency cells. CSV remains raw transaction export only.
- Bulk document generation is only included if it saves a real workflow; otherwise leave it in backlog.

Tasks:

- [ ] Recipe card PDF/print: ingredients, quantities, cost breakdown, margin, and notes.
- [ ] P&L PDF/print for month/year, manager-only, reconciling with financial dashboard numbers.
- [ ] Payroll payslip/period summary PDF/print, manager-only and PII-safe.
- [ ] XLSX export for P&L and payroll with formatting and formula-injection-safe text cells.
- [ ] Resend email action for generated documents: recipient validation, rate limiting, audit log,
      clear delivery/error states, and no cross-tenant attachments.
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
      Server Actions and Route Handlers use these before data access/mutations.
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
- No AI/OCR/free-form extraction. That remains backlog after billing and usage metering.

Schema:

- `import_jobs`: `organization_id`, `id`, `actor_user_id`, `entity`, `format`, `status`
  (`parsed`, `committed`, `expired`, `failed`), `source_filename`, `row_count`,
  `normalized_rows` JSON, `issues` JSON, `idempotency_key`, `expires_at`, timestamps.
- Add to `businessTables` and RLS. Jobs expire; confirmed jobs are immutable.

Tasks:

- [ ] Template generator for ingredients and transactions. Columns match export/import docs exactly.
- [ ] CSV/XLSX parsers that never evaluate formulas/macros and reject unknown sheets/columns.
- [ ] Zod row schemas and `parseImport()` that returns typed normalized rows plus per-row issues;
      malformed rows collect errors instead of throwing the whole request.
- [ ] Dry-run action: upload/parse/validate/plan rows, store `import_jobs`, return preview id.
- [ ] Confirm action: load job by id inside `withOrg`, re-check role and plan limits, apply rows in
      one transaction, mark committed with idempotency protection.
- [ ] UI: upload, entity/format selection, preview grid, per-row status, confirm, error handling,
      mobile usability, all localized.
- [ ] Tests: parser fixtures, formula/macro safety, unknown columns, row/file caps, locale money
      parsing, confirm idempotency, org isolation, and plan-limit enforcement.

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
- `.docx` table import is allowed only for real tables. Free-form prose remains backlog/AI extraction.

Tasks:

- [ ] `lib/import/resolveIngredient.ts`: exact, normalized, fuzzy, and new match outcomes, pure and tested.
- [ ] Recipe CSV/XLSX templates with recipe header rows and line rows, documented examples.
- [ ] Recipe import parser + row schemas + staged preview using `import_jobs`.
- [ ] Preview UI for resolving fuzzy ingredient matches and confirming creation of new ingredients.
- [ ] Confirm action creates/updates recipes and lines transactionally, re-checks recipe plan limits,
      and keeps cost honest for unpriced ingredients.
- [ ] Optional `.docx` table parser only if dependency and table extraction are proven in a spike.
- [ ] Tests: exact/fuzzy/new resolver, unit conversion, unknown units, new unpriced ingredients,
      duplicate recipe handling, org isolation, and plan-limit races.

Acceptance criteria:

- Import a recipe sheet referencing existing and new ingredients; existing ones link, new ones are staged as needing pricing, and recipe cost updates correctly once prices are filled.
- Fuzzy matches require explicit user confirmation.
- Confirm is idempotent and cannot write outside the active org.

---

## Sprint 5 - Launch readiness and beta operations

Goal: first real customers can use the product with supportable operations.

Tasks:

- [ ] Sentry client/server integration, preserving current `logError`/`eventId` shape.
- [ ] Playwright E2E smoke in CI: sign in, create recipe, enter transaction, view dashboard,
      create invoice, and verify kitchen RBAC blocks sensitive routes.
- [ ] Dependency maintenance: Dependabot/Renovate and `npm audit` policy in CI.
- [ ] PostHog or equivalent product analytics for key events, with no sensitive payloads.
- [ ] Lifecycle emails: welcome, receipt, low-stock alert, document send result.
- [ ] GDPR/EU readiness: org data export, deletion request workflow, retention docs for trash,
      audit log, invoices, and payroll PII.
- [ ] Accessibility and mobile review of core workflows at ~380px.
- [ ] Production operations checklist: env vars, domain, Neon backups/PITR, Vercel cron,
      status page, secret rotation, migration verification runbook.
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

Decisions to lock before coding:

- Use two tables: `task_lists` and `tasks`, mirroring the folder/trash patterns.
- Status is binary in v1: `todo` or `done`. No subtasks or `in_progress` yet.
- No cron recurrence in v1. Use manual reset/duplicate list actions.
- Plan gating proposal: Operations feature available from Starter, enforced server-side.

Tasks:

- [ ] `task_lists` and `tasks` tables, composite FKs, RLS, migration guard, isolation tests.
- [ ] Data layer and Server Actions for list/task CRUD, toggle, assign, reorder, reset, duplicate,
      soft-delete, restore, purge; Zod and ActionErrorCode throughout.
- [ ] Integrations: low-stock ingredient to reorder task; recipe to prep tasks.
- [ ] Extend trash/purge paths so purged recipes/ingredients null task source links first.
- [ ] Register tasks in global search for both roles.
- [ ] `/tasks` UI: list rail, task rows, status checkbox, assignee, due date, reorder,
      empty states, keyboard and mobile support.
- [ ] Tests for org isolation, RBAC, status toggle, assignment, reorder, soft-delete/restore,
      purge-null-link, reset/duplicate, integrations, and search registration.

Acceptance criteria:

- Create a prep list, add tasks, assign one, mark it done, and preserve order across reload.
- A low-stock ingredient can create a linked reorder task; purging the ingredient leaves the task intact with a null link.
- Kitchen can complete tasks but cannot create/delete lists or assign others.

---

## Backlog - not scheduled until prioritized

- AI extraction/OCR/free-form recipe import with human review, usage metering, and billing controls.
- Recipe scaling/batch planning.
- Suppliers as first-class entities with per-supplier price history.
- Saved reports and scheduled email summaries.
- True scheduled recurring checklists after Sprint 6 proves manual lists.
- Advanced audit-log UI for managers.
- Real Postgres concurrency test job for invoice numbering/import/stock beyond PGlite limits.
