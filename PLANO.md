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

Decisions LOCKED (resolved & approved before coding):
- **Date & timezone:** `occurred_on` is a bare `date` (`mode:'string'` → 'YYYY-MM-DD',
  no time/tz); monthly/annual buckets slice the string (org-local, zero tz math). ✓
- **Category model:** one `transaction_categories` table — predefined rows seeded
  idempotently per org with a stable `slug` (display via i18n `finance.categories.<slug>`,
  so renames never orphan rows), custom rows have `slug = null`; `kind` splits income/expense. ✓
- **Recipe link:** nullable `recipe_id` with composite `(org, recipe_id)` FK `ON DELETE
  restrict`; the recipe-purge path nulls the link first so financial records survive a purge. ✓
- **Tax:** DEFERRED (decided). `amount_cents` is the FULL GROSS amount as recorded; adding
  tax later is a purely additive migration — nullable `tax_rate` (numeric) + `tax_cents` (int),
  where `net = amount_cents − tax_cents` and existing rows mean "no tax recorded". Documented
  in the `transactions` schema comment.
- **Deletion (sub-decision):** transactions are soft-deleted (`deleted_at`) and wired into the
  existing `/trash` (manager-only) + 30-day auto-purge — no destructive delete, per Sprint 1.5.

Quick win first (next migration is 0009): add a guard to `scripts/migrate.ts` that aborts
with a clear message if a new journal `when` ≤ the max already-applied `created_at` — kills
the recurring silent-skip gotcha for good.

- [x] Migrate guard: pure `findSkippableMigrations` (tested) + abort in `scripts/migrate.ts`

Module work:
- [x] `transactions` table (org_id, type income|expense, category_id, nullable recipe_id,
      `occurred_on` date, `amount_cents` int, note) + `transaction_categories` (custom);
      migration 0009; both in `businessTables`; isolation test
- [x] Transaction CRUD (Server Actions, Zod, withOrg) with predefined + custom categories;
      list view with **period + category filters** and CSV **export**
- [x] `lib/calculations/finance.ts`: monthly/annual income, expenses, profit, by-category
      and top-products aggregations — pure functions + Vitest (reuse `dashboardSummary` shape)
- [x] Monthly dashboard: income, expenses, profit, top products — shadcn/ui charts on
      Recharts (added `recharts` + `components/ui/chart.tsx`, palette wired to our CSS tokens);
      period switcher; design-matched Suspense skeleton for the (heavier) chart queries
- [x] Annual dashboard: month-over-month evolution + prior-period comparison
- [x] `lib/calculations/breakEven.ts`: fixed costs + average contribution margin → units &
      revenue to break even — pure + Vitest (zero/negative-margin edge cases)
- [x] Break-even page with a live scenario simulator (price/cost/fixed-cost sliders)
- [x] Role gating: financials are `manager`-only (kitchen staff cannot read/edit) per DoD

Acceptance criteria:
- Seed ~12 transactions across ≥3 categories and 2 months → monthly & annual dashboards
  show correct income/expense/profit, by-category breakdown, and top products; numbers
  reconcile with the raw list and the CSV export.
- Break-even page computes units & revenue to break even and updates live as sliders move;
  a negative-margin scenario is handled gracefully (no NaN/∞).
- A `kitchen`-role user is blocked from the financials routes/actions; org isolation proven
  by an automated test.

---

## Sprint 2.5 — Spreadsheet & document import (onboarding)
Goal: a chef migrating from the old kit imports their existing ingredients, recipes, and
transactions from a file — reliably, with a preview-and-confirm step, NEVER an auto-commit.
Pairs with the Sprint 2 CSV **export** (same columns → symmetric round-trip) and builds the
reusable **ingredient resolver + import staging** layer that every later import source
(including the deferred AI extraction) rides on.

Reliability-first scoping (this is the whole point — "working well" means deterministic):
- **Tier 1 — structured, deterministic (THIS sprint):** Excel (`.xlsx`), `.csv`, and Word
  (`.docx`) *tables*. Tabular data maps column-by-column against a documented template;
  fully testable and trustworthy.
- **Tier 2 — free-form prose / images (NOT this sprint):** a recipe written as Word prose
  ("mix 200g flour with 2 eggs…") is the SAME extraction problem as a photo — it needs an
  LLM, is never 100%, and costs per call. Deferred to the backlog "AI extraction" item
  alongside OCR; it will reuse this sprint's resolver + staging. Do NOT build it here.

Decisions to LOCK in the plan (do not assume while coding):
- **One canonical format:** ship a downloadable XLSX/CSV template per entity (ingredients,
  recipes, transactions) whose columns are EXACTLY the Sprint 2 export columns — import and
  export are the same format. Document required vs optional columns + an example row.
- **Ingredient resolver (the hard core — build once):** for each imported line, normalize the
  name and match within the org — exact match → link to the existing ingredient; fuzzy/near
  match → surface as a suggestion in the preview (user confirms); no match → stage a NEW
  ingredient. A recipe file carries no prices, so new ingredients default to `priceCents = 0`
  with `dimension` inferred from the unit, and are flagged "needs pricing" so cost stays honest.
- **Units & money parsing:** unit strings → canonical g/ml/count via `lib/units` (an unknown
  unit is a row error, never a silent guess). Decimals → integer cents respecting the org's
  locale decimal separator (EUR "1,50" ≠ "1.50") — an explicit, tested edge case.
- **Staging, never auto-commit:** parse → Zod-validate → render a preview grid with a per-row
  status (create / update / skip / error + message) → the user confirms → the import applies
  in a transaction. A malformed file shows errors and imports nothing.
- **Safety:** cap file size and row count; treat the file as untrusted data — never evaluate
  spreadsheet formulas/macros; reject unknown sheets/columns with a clear message. Respect
  server-side plan limits (e.g. Starter's 50-recipe cap) so import can't bypass gating.
- **Parser libs (decide in plan mode):** XLSX read via `exceljs`; CSV via a small parser (or
  native); `.docx` tables via `mammoth`/docx table extraction. No heavyweight runtime dep
  beyond the chosen parser. No schema migration in v1 (an `import_jobs` history/undo table is
  explicitly deferred).

Module work:
- [ ] `lib/import/` parsers: `.xlsx` / `.csv` / `.docx`-table → a normalized row array, plus a
      downloadable template generator per entity (columns mirror the Sprint 2 export)
- [ ] `lib/import/resolveIngredient.ts`: pure, tested name-normalization + match
      (exact / fuzzy / new) within an org — the shared core for all import sources
- [ ] Zod row schemas per entity + a `parseImport()` returning typed rows + per-row issues
      (never throws on bad data; it collects errors)
- [ ] Import Server Actions (withOrg, org from Clerk): a dry-run that returns the preview, and
      a confirm that applies staged rows in a transaction; `ActionErrorCode` + i18n
- [ ] Import UI: upload → entity/format auto-detect → preview grid with per-row status and
      fuzzy-match resolution → confirm; honest empty/error states; mobile-usable (~380px)
- [ ] Wire into onboarding/empty states: when ingredients or recipes are empty, offer
      "Import from a file" next to "Add manually"
- [ ] i18n: all import strings via next-intl (incl. `actionErrors.*` for import codes)
- [ ] Tests (PGlite + fixtures): xlsx/csv/docx-table parsing, resolver matching (exact/fuzzy/
      new), unit conversion, locale cents parsing, malformed-file handling, plan-limit
      enforcement, and org isolation (an import only ever writes to the active org)

Acceptance criteria:
- Download the ingredients template, fill ~10 rows, re-import → all create correctly; a row
  with an unknown unit is flagged (not silently dropped) and the rest still import.
- Import a recipe sheet referencing both existing and new ingredients → existing ones link,
  new ones are staged "needs pricing"; the recipe's cost is correct once priced.
- A CSV exported by the app (Sprint 2) re-imports cleanly (round-trip), and an import never
  writes outside the active org (automated test).

Production note: no migration in v1. If the optional `import_jobs` table is added later for
history/undo, follow the DoD migration steps (journal `when` > the 0003 gotcha threshold).

---

## Sprint 2.7 — Global search (advanced & reliable)
Goal: one fast, typo-tolerant search across the org's data — a command palette (⌘K)
that finds recipes, ingredients and transactions and jumps straight to them.

Decisions LOCKED (resolve & approve before coding):
- **Postgres-native, no external search service.** Use `pg_trgm` (trigram) for fuzzy /
  typo tolerance + `tsvector` full-text where it helps, with ranked results. Keeps
  multi-tenancy trivial (same Neon DB, same RLS) — no second datastore to isolate.
- **Org-scoped + RLS-safe + RBAC-filtered.** Search runs inside `withOrg`; every query
  filters `organization_id` and `deleted_at IS NULL`; a `kitchen` user NEVER gets
  transaction / financial results (RULE: financials are manager-only).
- **Cross-entity, grouped results:** recipes, ingredients, transactions now (folders
  optional). **Invoices and customers don't exist yet** — they join the SAME index when
  they ship in Sprint 3 (see that sprint's "register into global search" task).
- **Pluggable registry, not hard-coded entities.** Each searchable entity registers a
  descriptor (table, searched columns, RBAC rule, result label + deep-link) so adding
  invoices/customers later is a few lines, not a rewrite.

- [x] Enable the `pg_trgm` extension + GIN trigram indexes on searchable text
      (recipes.name/notes, ingredients.name/supplier, transactions.note); migration 0010
      (journal `when` 1781632722380 > the 0003 gotcha threshold), isolation test
- [x] Search registry: a typed descriptor per entity (columns, RBAC predicate, label,
      href builder) so new entities plug in without touching the core (`lib/search/registry.ts`)
- [x] Unified search Server Action: org-scoped via `withOrg`, Zod-validated query,
      RBAC-filtered (kitchen excluded from transactions), soft-delete aware, ranked,
      capped per entity (`app/(app)/search/actions.ts` + `lib/search/run.ts`)
- [x] Pure ranking / snippet helpers in `lib/` + Vitest (typo tolerance, relevance order,
      empty / short-query / no-match edges) (`lib/search/ranking.ts`)
- [x] Command palette UI (⌘K / Ctrl-K) in the app shell: debounced input, results grouped
      by entity, full keyboard nav, loading / empty / error states, i18n strings, each
      result links into the right module (cmdk + shadcn; ingredient/transaction deep-links
      use `?highlight=`)
- [x] Performance: GIN trigram indexes created and confirmed usable (EXPLAIN → Bitmap Index
      Scan on `*_trgm_idx`); on tiny tables Postgres seq-scans, as expected

Acceptance criteria:
- A misspelled recipe / ingredient name still finds the right row (trigram), results
  ranked by relevance and grouped by entity.
- A `kitchen`-role user's search never returns transactions / financial data; org
  isolation proven by an automated test.
- ⌘K opens/closes, is fully keyboard-navigable, and every result navigates to the
  correct record.

---

## Sprint 3 — Invoices and payroll (modules 5 and 6 — data & builders)
Goal: the invoice and payroll DATA, builders and calculations. Their printable output
(PDF / Excel / email) is the dedicated Sprint 3.5 — this sprint stops at on-screen.

- [ ] `customers` table (org-scoped, soft-deletable): name, tax id, address, email —
      reused by invoices and searchable globally
- [ ] `invoices` + `invoice_items` tables; sequential numbering per organization
- [ ] Invoice builder: pick/create customer, line items, taxes, total (on-screen preview)
- [ ] `employees` and `shifts` tables (check-in/check-out, hourly rate) — employee data
      is PII: `manager`-only access
- [ ] Shift logging + automatic hours and pay-due calculation (pure, tested; integer cents)
- [ ] Per-employee summary per period (week/month) — on-screen
- [ ] Invoice numbering is gap-free and concurrency-safe per org (sequence/locked counter,
      tested under parallel inserts)
- [ ] Register `invoices` + `customers` into the Sprint 2.7 search registry (find an
      invoice by number/customer, a customer by name) — RBAC: invoices are `manager`-only

Acceptance criteria:
- Build an invoice (customer + items + taxes) and close an employee's payroll for the
  month on screen; a `kitchen`-role user cannot open payroll or invoices; invoice numbers
  never collide or skip.
- Global search (⌘K) now finds invoices by number/customer and customers by name, still
  org-scoped and RBAC-filtered (proven by test).

---

## Sprint 3.5 — Documents, printing, export & email
Goal: turn every key view into something the chef can hand to an accountant, a client or
the tax office — one consistent, branded document pipeline (print, PDF, Excel, email).
This is the home of ALL output; earlier sprints stop at on-screen data.

Decisions LOCKED (resolve & approve before coding):
- **One shared document layout**, not per-page one-offs: a react-pdf template + a matching
  print stylesheet (org logo/header/footer, currency via `formatMoney`, locale via
  next-intl) reused by every document, so they all look like one product.
- **PDF generation is server-side, org-scoped, RBAC-checked and XSS-safe**; rate-limited
  (cross-ref Sprint 4's PDF-gen limiter — wire the limiter here when the path is born).
- **Email delivery uses Resend** (introduced here for documents; Sprint 5's lifecycle
  emails build on the same client). Never email cross-tenant data; log every send.
- **Excel export uses a real `.xlsx`** (typed, formatted), complementing the existing CSV.

Documents (each: on-screen → print-friendly route → Download PDF → Email):
- [ ] Shared document layout + print stylesheet (the foundation all documents reuse)
- [ ] Invoice — PDF + print + "Email to customer" (uses the customer email from Sprint 3)
- [ ] Recipe card — ingredients, cost breakdown, per-portion cost & margin (great for the
      kitchen wall / sharing a spec sheet)
- [ ] P&L statement (monthly / annual) — `manager`-only — PDF + print
- [ ] Per-employee payroll summary / payslip — `manager`-only, PII-safe — PDF + print

Export & share:
- [ ] Excel (`.xlsx`) export of the P&L (income, expenses, profit, by-category, top
      products) — and of payroll — with formatting; CSV stays for raw transactions
- [ ] "Email this document" action (Resend): send any generated PDF (invoice, P&L,
      payroll) to a chosen recipient with a short message; delivery + errors surfaced
- [ ] Bulk / convenience: print or download a period's documents in one action where it
      saves the user real time (e.g. all of a month's invoices)

Acceptance criteria:
- An invoice, a recipe card, a monthly P&L and a payslip each render to a clean, branded
  PDF whose figures reconcile with the on-screen data; each also prints cleanly (print CSS).
- Exporting the P&L to `.xlsx` opens in Excel with correct numbers and formatting; emailing
  a P&L PDF reaches the inbox; neither ever leaks another org's data (automated test).
- A `kitchen`-role user cannot reach or generate any financial / payroll document
  (route + action), and rate limiting blocks PDF-gen abuse.

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

- [ ] Resend: welcome, receipt, and low-stock alert emails (reuses the Resend client +
      document-email path introduced in Sprint 3.5)
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

## Sprint 6 — Kitchen task & prep lists (kitchen operations module)
Goal: run the kitchen day on reliable, shared lists — **prep lists** (mise en place),
**reorder lists** fed by the existing low-stock alert, and recurring **opening/closing
checklists** — assignable to staff, with completion tracking. This is a chef-specific
task system, NOT a generic to-do: every list type is anchored in real kitchen data
(recipes → prep tasks, low-stock ingredients → reorder tasks). Both roles use it —
tasks are operational, not financial.

Why a dedicated sprint: the feature is small in surface but must be **trustworthy** (no
lost edits, no cross-tenant leak, honest offline/empty states). It deliberately reuses
three patterns the codebase already proved: the **folder pattern** (Sprint 1.6:
list ≈ folder, nullable `list_id`, composite FK, manual `sort_order`), the **trash
pattern** (Sprint 1.5: `deleted_at` + 30-day auto-purge), and the **search registry**
(Sprint 2.7: a descriptor so tasks are findable via ⌘K). No new heavyweight dependency.

Decisions to LOCK (resolve & approve before coding):
- **Two tables, mirroring the folder pattern.** `task_lists` (org_id, name, `kind`
  prep|reorder|checklist|general, `sort_order`, unique(org,name), composite (org,id) FK
  target; HARD-delete → reassign its tasks to NULL, never trashed — same call as
  `deleteFolder`). `tasks` (org_id, nullable `list_id` composite (org,list_id) FK ON
  DELETE RESTRICT, `title`, nullable `notes`, `status` todo|done, nullable
  `assigned_to` = a Clerk org-member user id (NOT the payroll `employees` table — org
  membership already exists from Sprint 0), nullable `due_on` bare date, `position` int
  for manual ordering, nullable `recipe_id` + nullable `ingredient_id` composite FKs ON
  DELETE RESTRICT for the source link, `created_by`, timestamps, `deleted_at`).
- **Status is binary (todo|done) in v1**, with optimistic toggle + server reconcile. An
  `in_progress` state and per-task subtasks are explicitly DEFERRED (keeps the sprint
  single + reliable).
- **No cron-based recurrence in v1.** Recurring checklists are served by a **"reset
  list"** action (mark every task in a checklist back to `todo`) and a **"duplicate
  list"** action — deterministic, testable, no scheduler. True scheduled recurrence is a
  backlog item.
- **Soft-delete, not destructive** (Sprint 1.5): tasks `deleted_at` → `/trash` + 30-day
  auto-purge; `task_lists` hard-delete. The recipe/ingredient purge paths NULL the task
  source link first (extend `purgeRecipe`/`purgeExpired`) so a task survives a purge.
- **RBAC: both `manager` and `kitchen` read + toggle tasks** (operational data). Creating/
  renaming/deleting LISTS and ASSIGNING tasks to others is `manager`-only via
  `getUserRole()`. (Confirm in plan mode.)
- **Plan gating (Sprint 4):** decide which plans include task lists (proposal: a core
  Operations feature, available from **Starter**). Enforce server-side via Clerk `has()`.

Module work:
- [ ] `task_lists` + `tasks` tables (both in `businessTables` → RLS auto-applies);
      composite FKs; next migration in sequence with its journal `when` cleared past the
      gotcha threshold (DoD); PGlite isolation test (org A can't read org B's tasks)
- [ ] Data layer `lib/data/tasks.ts` + `task-lists.ts` (list / create / update /
      toggle-status / assign / reorder / soft-delete / restore / purge + list CRUD +
      reset-list + duplicate-list) — all org-scoped, `deleted_at IS NULL`, reusing the
      folder + trash helpers
- [ ] Server Actions (Zod, org from Clerk, `withOrg`): task CRUD + status toggle + assign
      + move/reorder + list CRUD; `ActionErrorCode` + next-intl (`actionErrors.*`)
- [ ] Integrations (the whole point — anchored in real data): a **"Create reorder task"**
      action on the inventory low-stock alert (links `ingredient_id`, reuses `isLowStock`);
      an **"Add prep tasks"** action from a recipe (links `recipe_id`)
- [ ] Wire `tasks` into `/trash` (soft-deleted, restorable) + the existing 30-day
      auto-purge fan-out; extend recipe/ingredient purge to NULL task links first
- [ ] Register `tasks` into the Sprint 2.7 search registry (find a task by title;
      RBAC: all roles) — a few lines, no core change
- [ ] `/tasks` page: lists rail (reuse the `folder-rail` pattern) + task list with
      status checkbox, assignee, due date, manual reorder; honest empty states;
      mobile-usable (~380px); fully keyboard-reachable. Match the dashboard's Card +
      `text-base` CardTitle design language
- [ ] i18n: all task strings via next-intl
- [ ] Tests (PGlite): list/task CRUD + org isolation, status toggle, assignment,
      reorder, soft-delete/restore/purge, reset-list + duplicate-list, low-stock→reorder
      and recipe→prep integrations, purge-nulls-link, and the search registration

Acceptance criteria:
- Create a prep list, add tasks, assign one to a staff member, mark it done; the order
  persists across reload; it all works at ~380px and via keyboard only.
- A low-stock ingredient → one click creates a reorder task linked to it; permanently
  purging that ingredient does not break or orphan the task (link goes NULL).
- A `kitchen`-role user can view and complete tasks but cannot create/delete lists or
  assign others; org isolation proven by an automated test.
- A deleted task appears in `/trash`, restores cleanly, and auto-purges after 30 days;
  ⌘K finds a task by title (still org-scoped + RBAC-filtered).

Production note: Vercel does not run migrations — run `npm run db:migrate` against prod
Neon after merge and VERIFY `task_lists` + `tasks` exist live; ensure the new migration's
journal `when` exceeds prod's max `created_at` (the recurring 0003 gotcha; the migrate
guard now aborts on a bad order).

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
- **AI extraction (OCR photos + free-form docs):** import a recipe from a photo (OCR) or from
  free-form Word/prose text — the same LLM-based extraction, never 100% reliable, costs per
  call. Reuses Sprint 2.5's ingredient resolver + import staging (always draft → human review,
  never auto-commit); gate as a Pro/Business feature with usage metering → schedule AFTER
  Sprint 4 (billing). (Note: structured `.xlsx`/`.csv` and Word *tables* are NOT here — they
  ship deterministically in Sprint 2.5.)
- **Recipe scaling / batch:** scale a recipe to N portions or a target cost.
- **Suppliers** as a first-class entity (currently a free-text field) with per-supplier prices.
- **Saved reports / scheduled email summaries** (monthly P&L to the owner).
- **Scheduled / recurring checklists** (Sprint 6 follow-up): true cron-based recurrence for
  opening/closing checklists (daily/weekly auto-instantiation), beyond v1's manual reset/
  duplicate actions. Reuses the existing Vercel Cron + per-org fan-out from Sprint 1.5.
