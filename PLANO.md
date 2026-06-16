# PLANO.md — PrepProfit SaaS: executable roadmap

Instructions for Claude Code: work one sprint at a time, in order.
Mark completed tasks with [x]. Do not start a sprint before the previous one is done.
Before each sprint: enter plan mode, resolve the listed decisions, get approval.

---

## Definition of Done (applies to EVERY sprint task — no exceptions, no "later")
- **Multi-tenancy:** every new table has `organization_id`; every query is org-scoped
  (RULE #1); the table is in `businessTables` so RLS auto-applies; a PGlite isolation
  test (`tenant_app` role) proves org A cannot read org B's rows.
- **Money & math:** monetary values are integer cents; cost/margin/break-even logic is
  pure functions in `lib/calculations/` with Vitest tests covering edge cases (zero,
  negative, rounding).
- **Validation & errors:** all user input validated with Zod on the server; action
  failures return an `ActionErrorCode` mapped to next-intl (`actionErrors.*`) — never a
  hardcoded string. Unexpected throws go through `unexpected()` (logged `eventId`).
- **i18n & types:** all UI strings via next-intl; no `any`, no `@ts-ignore`; types derive
  from the Drizzle schema.
- **Authorization:** sensitive data/actions gated by role (`manager` vs `kitchen`) via
  `getUserRole()` / Clerk `has()` — kitchen staff must not reach financials/payroll.
- **UX:** honest empty states; design-matched skeleton ONLY where data is genuinely slow
  (no blanket fallbacks); usable on mobile (test ~380px); controls keyboard-reachable and
  labelled.
- **Migrations:** after `db:generate`, ensure the journal `when` clears the gotcha
  threshold; run `db:migrate` on prod and VERIFY the columns exist live.
- **Green gate:** `lint && typecheck && test` and `next build` pass in CI before merge;
  small conventional commits; observable errors.

---

## Sprint 0 — Multi-tenant foundation
Goal: the SaaS skeleton with per-organization data isolation working.

- [x] Initialize Next.js 15 + TypeScript + Tailwind project (or import the Wibox base if provided)
- [x] Install and configure Drizzle ORM pointing at Neon Postgres
- [x] Configure Clerk with Organizations enabled; middleware protecting /app/*
      (code ready; enable Organizations in the Clerk dashboard — see SETUP.md)
- [x] Create `lib/auth.ts` with `getOrgId()` (throws if no active org)
- [x] Initial Drizzle schema: `ingredients`, `recipes`, `recipe_ingredients`
      tables, all with `organization_id` + composite index
- [x] Enable Row-Level Security in Postgres as a second layer of defense
- [x] Seed script with example data for 2 distinct organizations
- [x] Automated test: org A never sees org B's data
- [x] Base layout: sidebar with modules, Clerk OrganizationSwitcher, empty page per module
- [~] Deploy to Vercel with production Neon; simple CI (lint + typecheck + test)
      (CI ready in .github/workflows/ci.yml; Vercel deploy pending credentials — see SETUP.md)

Acceptance criterion: two users from different orgs sign in and see isolated data.

---

## Sprint 1 — Recipes and ingredients (modules 1 and 3)
Goal: chef registers ingredients, builds recipes, and sees real cost.

Foundations first (do these before the CRUD — they are cheap now and a painful
migration later, once money and quantities exist across every table):

- [x] `organization_settings` table (org_id PK, `currency` ISO-4217,
      `measurement_system` metric|imperial) + `getOrgSettings()` helper; small
      settings page to edit them. Follows RULE #1 (per-org, derived server-side)
- [x] `lib/format/money.ts`: `formatMoney(cents, currency)` via `Intl.NumberFormat`.
      ALL monetary display goes through it. Single currency per org — NO currency
      conversion (storage stays integer cents)
- [x] `lib/units/` pure conversion helpers with Vitest tests: canonical storage in
      grams/ml, convert g/kg↔oz/lb and ml/l↔fl oz/cups at the UI edge, driven by
      the org `measurement_system`
- [x] Decide quantity dimensions in the schema: weight (grams) is in place — add
      volume (ml) and count so liquids (oil, milk, stock) and per-piece items
      (eggs) work; migration as needed

Then the module work:

- [x] Ingredient CRUD (name, unit, price per unit/kg, optional supplier)
- [x] Editable ingredient grid with TanStack Table (inline editing)
- [x] Recipe CRUD: ingredients + quantities, yield (portions), % loss
- [x] `lib/calculations/recipeCost.ts`: total cost, cost per portion,
      hidden costs (labor, energy, packaging) — with Vitest tests
- [x] Suggested selling price + margin with a traffic light (green/yellow/red)
- [x] Cascade update: ingredient price changed → recalculate recipes
      (costs derived live from current ingredient prices; recipe pages are dynamic
      and ingredient mutations revalidate /recipes — no stored cost to update)
- [x] Inventory: stock in/out per ingredient
- [x] Low-stock visual alert (configurable threshold per ingredient)

Acceptance criterion: create a recipe with 5 ingredients and see correct cost and margin.

---

## Sprint 1.5 — Trash / soft-delete (foundations)
Goal: no destructive delete; recipes and ingredients go to a 30-day trash, restorable.

- [x] `deleted_at` column + index on `recipes` and `ingredients`; migration 0006
- [x] Filter all active reads by `deleted_at IS NULL`; keep recipe-cost joins intact
- [x] Soft-delete / restore / purge data fns + dependency guards (block in-use
      ingredient; block restoring a recipe with trashed ingredients)
- [x] Confirm-before-delete via a native `<dialog>` ConfirmDialog (no Radix)
- [x] `/trash` page: restore + permanent delete + days-left; sidebar + top-bar wiring
- [x] Auto-purge after 30 days: CRON_SECRET-protected route, Clerk per-org fan-out,
      vercel.json daily schedule
- [x] Tests: soft-delete/restore/purge, in-use block, restore guard, expiry, org isolation

Acceptance criterion: delete a recipe → it leaves the list, appears in /trash with
~30 days left, restores cleanly; an ingredient used by an active recipe cannot be trashed.

Production note: Vercel does not run migrations — run `npm run db:migrate` against
prod Neon after merge, and set `CRON_SECRET` in the Vercel project env.

---

## Sprint 1.6 — Recipe organization / folders (foundations)
Goal: chefs file recipes into named folders — create, rename, move, reorder, with
coherent empty states and per-folder counts. Establishes a reusable folder pattern
for later modules and coexists with the trash (reads still filter deleted_at IS NULL).

- [x] `recipe_folders` table (org_id, name, sort_order, timestamps; unique(org,name);
      composite (org,id) FK target) + nullable `recipes.folder_id` with composite
      (org,folder_id) FK ON DELETE RESTRICT + index (org,folder_id). Migration 0007.
      Folders are hard-delete (not trashed); folder delete reassigns recipes to NULL
      in one transaction
- [x] Add `recipe_folders` to `businessTables` so RLS auto-applies (org isolation)
- [x] Data layer `lib/data/recipe-folders.ts` (list / list-with-counts / create /
      rename / reorder / delete) + `moveRecipeToFolder` + folder-filtered `listRecipes`;
      all org-scoped and deleted_at IS NULL
- [x] Server Actions (Zod, org from Clerk, withOrg): folder CRUD + reorder + move
      recipe; unique-name violations surfaced
- [x] /recipes UI: folder rail (All / folders / No folder + live counts), ?folder=
      server filter, create/rename/reorder/delete folder, move recipe (card + editor),
      coherent empty states. Native controls; reuse ConfirmDialog for folder delete
- [x] i18n: all folder strings via next-intl
- [x] Tests (PGlite): folder CRUD + org isolation, unique-name, reorder, delete →
      recipes NULL, move, per-folder counts, folder views exclude trashed recipes

Acceptance criterion: create folders, file recipes, rename/reorder/move, delete a
folder → its recipes fall back to "No folder" (nothing trashed), and trashed recipes
never appear in any folder view or count.

Production note: Vercel does not run migrations — run `npm run db:migrate` against
prod Neon after merge and VERIFY `recipe_folders` + `recipes.folder_id` exist (the
0003 `when` gotcha). Ensure 0007's journal `when` > 1781601000000.

---

## Sprint 1.7 — Hardening (senior-level baseline)
Goal: close the gaps that separate "works" from production-grade before Sprint 2.
Graceful failure UX, fully-translated errors, build caught in CI, fail-fast env
validation, and diagnosable production errors. No new runtime dependency.

- [x] Error/404 boundaries: `app/global-error.tsx` (provider-less fallback),
      `app/(app)/error.tsx` (localized, retry + back), `app/not-found.tsx`
      (branded 404). NOTE: the blanket `app/(app)/loading.tsx` skeleton was
      removed — it flashed on every (even fast) navigation and couldn't match
      each page's design; route-specific, design-matched skeletons are added only
      where data is genuinely slow (e.g. the Sprint 2 dashboard)
- [x] Translated action errors: `ActionResult` failure arm carries a stable
      `ActionErrorCode` (not English strings); all action returns use codes; client
      maps via `useActionError()` hook + `actionErrors.*` i18n block
- [x] `next build` added to CI (`.github/workflows/ci.yml`) with Clerk key env
      (repo secrets, valid-format dummy fallback)
- [x] Env validation: `lib/env.ts` `serverEnv()` (Zod, lazy, cached) used by the
      Neon client + cron route; `lib/env.test.ts`
- [x] Error observability: `lib/observability.ts` `logError`/`unexpected` —
      structured one-line log with `eventId`; actions' bare `throw err` replaced
      with logged `UNEXPECTED`; boundaries log client-side too

Out of scope (later sprints): Playwright E2E smoke; Clerk webhooks + Sentry; org
lifecycle / custom-role delete control (Sprint 4 billing). Ops still owed:
`CRON_SECRET` in Vercel env (the cron route 401s until set — now fails explicitly).

---

## Sprint 2 — Financials and break-even (modules 2 and 4)
Goal: answer "how much did I really make this month?" — accurately and per-org.

Decisions to LOCK in the plan (do not assume while coding):
- **Date & timezone:** store `occurred_on` as a `date` (no time); bucket monthly/annual
  in a single, documented convention (org-local calendar date, no tz math on a bare date).
- **Category model:** predefined enum seed + a `transaction_categories` table for custom
  per-org categories (so reports group stably and renames don't orphan rows).
- **Recipe link:** a transaction MAY reference a recipe (nullable `recipe_id`, composite
  org FK) to power "top products"; income without a recipe is still valid.
- **Tax:** capture an optional `tax_rate`/`tax_cents` now (chefs reconcile VAT) or defer —
  decide explicitly; if deferred, leave a migration-friendly note.

Quick win first (next migration is 0009): add a guard to `scripts/migrate.ts` that aborts
with a clear message if a new journal `when` ≤ the max already-applied `created_at` — kills
the recurring silent-skip gotcha for good.

Module work:
- [ ] `transactions` table (org_id, type income|expense, category_id, nullable recipe_id,
      `occurred_on` date, `amount_cents` int, note) + `transaction_categories` (custom);
      migration; both in `businessTables`; isolation test
- [ ] Transaction CRUD (Server Actions, Zod, withOrg) with predefined + custom categories;
      list view with **period + category filters** and CSV **export**
- [ ] `lib/calculations/finance.ts`: monthly/annual income, expenses, profit, by-category
      and top-products aggregations — pure functions + Vitest (reuse `dashboardSummary` shape)
- [ ] Monthly dashboard: income, expenses, profit, top products — shadcn/ui charts on
      Recharts (add `recharts` + `components/ui/chart.tsx`, palette wired to our CSS tokens);
      period switcher; design-matched skeleton for the (heavier) chart queries
- [ ] Annual dashboard: month-over-month evolution + prior-period comparison
- [ ] `lib/calculations/breakEven.ts`: fixed costs + average contribution margin → units &
      revenue to break even — pure + Vitest (zero/negative-margin edge cases)
- [ ] Break-even page with a live scenario simulator (price/cost/fixed-cost sliders)
- [ ] Role gating: financials are `manager`-only (kitchen staff cannot read/edit) per DoD

Acceptance criteria:
- Seed ~12 transactions across ≥3 categories and 2 months → monthly & annual dashboards
  show correct income/expense/profit, by-category breakdown, and top products; numbers
  reconcile with the raw list and the CSV export.
- Break-even page computes units & revenue to break even and updates live as sliders move;
  a negative-margin scenario is handled gracefully (no NaN/∞).
- A `kitchen`-role user is blocked from the financials routes/actions; org isolation proven
  by an automated test.

---

## Sprint 3 — Invoices and payroll (modules 5 and 6)
Goal: complete parity with the 5 spreadsheets of the original kit.

- [ ] `invoices` + `invoice_items` tables; sequential numbering per organization
- [ ] Invoice builder: customer, items, taxes, total
- [ ] Invoice PDF generation (react-pdf) with the organization's logo
- [ ] `employees` and `shifts` tables (check-in/check-out, hourly rate) — employee data
      is PII: `manager`-only access, and the PDF/render path is XSS-safe
- [ ] Shift logging + automatic hours and pay-due calculation (pure, tested; integer cents)
- [ ] Per-employee summary per period (week/month)
- [ ] Invoice numbering is gap-free and concurrency-safe per org (sequence/locked counter,
      tested under parallel inserts)

Acceptance criterion: generate an invoice PDF and close an employee's payroll for the month;
a `kitchen`-role user cannot open payroll; invoice numbers never collide or skip.

---

## Sprint 4 — Billing with Clerk Billing + Stripe
Goal: the product accepts payments.

- [ ] Enable Clerk Billing (B2B, per-Organization plans) and connect the Stripe account
- [ ] Create Starter / Pro / Business plans in the Clerk dashboard with Features
- [ ] /pricing page with Clerk's <PricingTable />
- [ ] Gating: `has({plan})` / <Protect> on modules per CLAUDE.md
- [ ] Starter limits (50 recipes, 1 user) enforced on the SERVER (not just UI)
- [ ] Post-signup onboarding flow: create org → choose plan → 3-step tour
- [ ] In-app billing page (manage subscription via Clerk components)
- [ ] Billing/Clerk webhooks (signature-verified): sync subscription + org/user lifecycle;
      on member-removed / org-deleted, handle data ownership/cleanup
- [ ] Custom `Owner` role without `org:sys_profile:delete` so customers can't self-delete
      the org (creator role keeps delete — see memory `org-and-billing-decisions`)
- [ ] Basic rate limiting on expensive/abusable endpoints (PDF gen, cron, auth-adjacent)

Acceptance criterion: subscribe to the Pro plan with a test card and unlock modules; a
forged webhook is rejected; server-side plan limits hold even if the client bypasses the UI.

---

## Sprint 5 — Launch polish
Goal: ready for the first real customers.

- [ ] Resend: welcome, receipt, and low-stock alert emails
- [ ] Sentry configured (client + server) — swap the `logError` sink, keep the shape
- [ ] PostHog: key events (created recipe, generated invoice, viewed break-even)
- [ ] Playwright E2E smoke: sign-in → create recipe → enter transaction → see dashboard;
      runs in CI (Clerk test instance)
- [ ] Dependabot (or Renovate) + `npm audit` gate in CI for dependency/security updates
- [ ] GDPR/data-protection (EU): per-org data export + account/data deletion request flow;
      document retention (trash 30 days, payroll PII)
- [ ] i18n hygiene: zero hardcoded strings, all via next-intl
- [ ] Public landing page with value proposition + CTA to /pricing
- [ ] Accessibility and mobile responsiveness review of the main modules
- [ ] Production checklist: env vars, domain, Neon backups + PITR, status page, rotate any
      secrets exposed during development (e.g. the Neon password)

Acceptance criterion: invite 3 beta chefs and have them complete onboarding without help;
the E2E smoke is green in CI and a data-export request returns the org's data.

---

## Cross-cutting concerns & backlog (tracked, scheduled — not lost)
Engineering/security carried across sprints (enforced via the Definition of Done unless a
dedicated item exists):
- **RBAC enforcement** (`manager` vs `kitchen`) — wired in Sprint 2 (financials) and Sprint 3
  (payroll); audit every sensitive action.
- **Audit log** (who changed what, per org) — B2B multi-user expectation; target Sprint 4
  (once roles/billing matter). Append-only table, org-scoped.
- **Rate limiting & abuse** — Sprint 4; revisit if a public/unauthenticated surface appears.
- **E2E + dependency scanning** — Sprint 5 (Playwright smoke, Dependabot, `npm audit`).
- **Webhooks & lifecycle** (Clerk/billing, org/member removal cleanup) — Sprint 4.
- **GDPR data export/delete + retention** — Sprint 5.

Product backlog (not yet scheduled — promote into a sprint when prioritized):
- **Spreadsheet onboarding:** CSV/XLSX **import** of ingredients & transactions (chefs migrate
  from the old kit) — pairs with the Sprint 2 export.
- **Recipe scaling / batch:** scale a recipe to N portions or a target cost.
- **Suppliers** as a first-class entity (currently a free-text field) with per-supplier prices.
- **Global search** across recipes/ingredients/transactions.
- **Saved reports / scheduled email summaries** (monthly P&L to the owner).
