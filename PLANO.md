# PLANO.md — PrepProfit SaaS: executable roadmap

Instructions for Claude Code: work one sprint at a time, in order.
Mark completed tasks with [x]. Do not start a sprint before the previous one is done.

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
- [ ] `lib/format/money.ts`: `formatMoney(cents, currency)` via `Intl.NumberFormat`.
      ALL monetary display goes through it. Single currency per org — NO currency
      conversion (storage stays integer cents)
- [ ] `lib/units/` pure conversion helpers with Vitest tests: canonical storage in
      grams/ml, convert g/kg↔oz/lb and ml/l↔fl oz/cups at the UI edge, driven by
      the org `measurement_system`
- [ ] Decide quantity dimensions in the schema: weight (grams) is in place — add
      volume (ml) and count so liquids (oil, milk, stock) and per-piece items
      (eggs) work; migration as needed

Then the module work:

- [ ] Ingredient CRUD (name, unit, price per unit/kg, optional supplier)
- [ ] Editable ingredient grid with TanStack Table (inline editing)
- [ ] Recipe CRUD: ingredients + quantities, yield (portions), % loss
- [ ] `lib/calculations/recipeCost.ts`: total cost, cost per portion,
      hidden costs (labor, energy, packaging) — with Vitest tests
- [ ] Suggested selling price + margin with a traffic light (green/yellow/red)
- [ ] Cascade update: ingredient price changed → recalculate recipes
- [ ] Inventory: stock in/out per ingredient
- [ ] Low-stock visual alert (configurable threshold per ingredient)

Acceptance criterion: create a recipe with 5 ingredients and see correct cost and margin.

---

## Sprint 2 — Financials and break-even (modules 2 and 4)
Goal: answer "how much did I really make this month?".

- [ ] `transactions` table (income/expense, category, date, value in cents)
- [ ] Transaction CRUD with predefined + customizable categories
- [ ] Monthly dashboard: income, expenses, profit, top products (Tremor)
- [ ] Annual dashboard: month-over-month evolution, comparison
- [ ] `lib/calculations/breakEven.ts`: fixed costs + average margin → units
      needed to break even — with tests
- [ ] Break-even page with a scenario simulator (price/cost sliders)

Acceptance criterion: enter 10 transactions and see coherent dashboards and break-even.

---

## Sprint 3 — Invoices and payroll (modules 5 and 6)
Goal: complete parity with the 5 spreadsheets of the original kit.

- [ ] `invoices` + `invoice_items` tables; sequential numbering per organization
- [ ] Invoice builder: customer, items, taxes, total
- [ ] Invoice PDF generation (react-pdf) with the organization's logo
- [ ] `employees` and `shifts` tables (check-in/check-out, hourly rate)
- [ ] Shift logging + automatic hours and pay-due calculation
- [ ] Per-employee summary per period (week/month)

Acceptance criterion: generate an invoice PDF and close an employee's payroll for the month.

---

## Sprint 4 — Billing with Clerk Billing + Stripe
Goal: the product accepts payments.

- [ ] Enable Clerk Billing (B2B, per-Organization plans) and connect the Stripe account
- [ ] Create Starter / Pro / Business plans in the Clerk dashboard with Features
- [ ] /pricing page with Clerk's <PricingTable />
- [ ] Gating: `has({plan})` / <Protect> on modules per CLAUDE.md
- [ ] Starter limits (50 recipes, 1 user) enforced on the server
- [ ] Post-signup onboarding flow: create org → choose plan → 3-step tour
- [ ] In-app billing page (manage subscription via Clerk components)

Acceptance criterion: subscribe to the Pro plan with a test card and unlock modules.

---

## Sprint 5 — Launch polish
Goal: ready for the first real customers.

- [ ] Resend: welcome, receipt, and low-stock alert emails
- [ ] Sentry configured (client + server)
- [ ] PostHog: key events (created recipe, generated invoice, viewed break-even)
- [ ] i18n hygiene: zero hardcoded strings, all via next-intl (English only for
      this first phase; locale infra stays in place for future languages)
- [ ] Public landing page with value proposition + CTA to /pricing
- [ ] Accessibility and mobile responsiveness review of the main modules
- [ ] Production checklist: env vars, domain, Neon backups, status page

Acceptance criterion: invite 3 beta chefs and have them complete onboarding without help.
