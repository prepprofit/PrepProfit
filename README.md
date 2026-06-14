<div align="center">
  <img src="public/logo_final.jpg" alt="PrepProfit" width="80" height="80" style="border-radius:12px" />

  <h1>PrepProfit</h1>

  <p><strong>Multi-tenant financial management for chefs and food businesses.</strong><br/>
  A spreadsheet kit reimagined as a subscription SaaS.</p>

  <p>
    <img alt="CI" src="https://github.com/Napster13Nord/PrepProfit/actions/workflows/ci.yml/badge.svg" />
    <img alt="Next.js" src="https://img.shields.io/badge/Next.js-15-black?logo=next.js" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white" />
    <img alt="License" src="https://img.shields.io/badge/license-proprietary-lightgrey" />
  </p>
</div>

---

## Overview

PrepProfit replaces the spreadsheet kit (Excel/Google Sheets) with a multi-tenant
subscription web app built for the reality of restaurants, bakeries and
patisseries. Each organization's data is **fully isolated**; the cost, margin and
break-even calculations — the heart of the product — live in pure, tested
functions.

## Product modules

| # | Module | Description |
|---|--------|-------------|
| 1 | **Recipes** | Recipe cost (ingredients → total cost, per portion, margin) |
| 2 | **Financials** | Income, expenses and a monthly/annual dashboard |
| 3 | **Inventory** | Stock in/out and low-stock alerts |
| 4 | **Break-even** | Break-even with scenario simulation |
| 5 | **Payroll** | Shifts, hours and per-employee pay |
| 6 | **Invoices** | PDF invoice generation |

Subscription plans (Starter / Pro / Business) unlock modules via Clerk Billing.

## Stack

- **Next.js 15** (App Router) · **React 19** · strict **TypeScript**
- **PostgreSQL** (Neon) + **Drizzle ORM**
- **Clerk** (auth + Organizations) and **Clerk Billing** over **Stripe**
- **Tailwind CSS v4** + **shadcn/ui** (+ Tremor for dashboards)
- **next-intl** (English to start) · **Zod** (server-side validation)
- **Vitest** + **PGlite** (database tests with no external dependencies)
- Deployed on **Vercel**

## Multi-tenant architecture (rule #1)

Per-organization isolation in **two independent layers**:

1. **Application layer (primary)** — `organization_id` **always** comes from Clerk
   on the server (`getOrgId()` in [`lib/auth.ts`](lib/auth.ts)); never from the
   client. All data access goes through helpers in [`lib/data/`](lib/data) that
   inject `organization_id` into the `WHERE`/`INSERT`.
2. **Database layer (defense in depth)** — **Row-Level Security** with `FORCE` on
   every table ([`lib/db/rls.ts`](lib/db/rls.ts)). The policy only exposes rows
   whose `organization_id` matches the `app.current_org_id` GUC, set per
   transaction in [`runInOrg()`](lib/db/tenant.ts). With no organization context,
   **no row passes** (secure by default).

> Monetary values are always `integer` cents — never float.

## Project structure

```
app/
  (marketing)/        Public landing page
  (app)/              Authenticated shell (sidebar + OrganizationSwitcher) + modules
  sign-in, sign-up    Clerk pages
  select-organization Organization selection/creation
components/
  ui/                 shadcn/ui primitives (button, card, …)
  app/                Sidebar, module placeholders
lib/
  auth.ts             getOrgId(), roles
  db/                 schema (Drizzle), RLS, Neon client, runInOrg()
  data/               Data access — always scoped by organization
  i18n/               Configuration + message catalog (English)
drizzle/              Generated migrations
scripts/              migrate.ts (schema + RLS), seed.ts (2 organizations)
tests/                isolation.test.ts — proves isolation between orgs
```

## Getting started

```bash
npm install
npm test          # runs now, no credentials (in-memory Postgres via PGlite)
```

To run the real app, set up Neon and Clerk and fill in `.env.local` — the full
walkthrough is in **[SETUP.md](SETUP.md)**.

```bash
cp .env.example .env.local   # fill in DATABASE_URL and the Clerk keys
npm run db:migrate           # create tables + apply RLS
npm run seed                 # (optional) seed 2 example organizations
npm run dev                  # http://localhost:3000
```

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Tests (Vitest + PGlite) |
| `npm run db:generate` | Generate a migration from the schema |
| `npm run db:migrate` | Apply migrations + RLS policies |
| `npm run seed` | Seed two organizations with isolated data |

## Testing

Multi-tenant isolation is verified automatically in
[`tests/isolation.test.ts`](tests/isolation.test.ts): an in-memory Postgres
(PGlite) receives the **same** production migrations and policies, and the test
proves — on both layers — that organization A can never see organization B's data.
It needs no external database, so it runs in CI without secrets.

## Deployment

Import the repository on **Vercel**, set the environment variables (see
[SETUP.md](SETUP.md)), and run `npm run db:migrate` against the production Neon
before the first deploy. Continuous integration (lint + typecheck + test) runs on
every push via [GitHub Actions](.github/workflows/ci.yml).

## Roadmap

Development follows **[PLANO.md](PLANO.md)**, sprint by sprint:

- [x] **Sprint 0** — Multi-tenant foundation (schema, RLS, auth, shell, isolation tested)
- [ ] **Sprint 1** — Recipes and ingredients (CRUD, real cost, margin)
- [ ] **Sprint 2** — Financials and break-even
- [ ] **Sprint 3** — Invoices and payroll
- [ ] **Sprint 4** — Billing (Clerk Billing + Stripe)
- [ ] **Sprint 5** — Launch polish

---

<div align="center"><sub>Project conventions and rules in <a href="CLAUDE.md">CLAUDE.md</a> · Design system in <a href="DESIGN.md">DESIGN.md</a></sub></div>
