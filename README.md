<div align="center">
  <img src="public/logo.webp" alt="PrepProfit" width="240" />

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

PrepProfit replaces the spreadsheet kit with a multi-tenant SaaS for restaurants,
bakeries, patisseries, and other food businesses. Each organization's data is isolated
by application-level org scoping and Postgres Row-Level Security. Cost, margin,
break-even, invoice, payroll, and finance calculations live in pure tested modules.

## Product modules

| # | Module | Current scope |
|---|--------|---------------|
| 1 | Recipes | Recipe cost, yield/loss, hidden costs, margin, folders, trash |
| 2 | Financials | Transactions, categories, CSV export, monthly/annual dashboard |
| 3 | Inventory | Stock movements, authoritative ledger, low-stock thresholds |
| 4 | Break-even | Scenario simulator with safe zero/negative-margin handling |
| 5 | Payroll | Employees, shifts, period summaries, manager-only |
| 6 | Invoices | Customers, draft/issue/pay/void lifecycle, gap-free numbering |
| 7 | Global search | Typo-tolerant search across allowed entities with RBAC |

Planned next: production hardening, document/PDF generation, billing, deterministic
imports, AI photo recipe extraction, launch readiness, and optional kitchen task lists.
See [PLANO.md](PLANO.md).

## Stack

Active stack:

- Next.js 15 App Router, React 19, strict TypeScript
- PostgreSQL on Neon with Drizzle ORM
- Clerk auth with Organizations and org roles
- Tailwind CSS v4, shadcn/ui patterns, Recharts
- next-intl for UI copy and action error messages
- Zod for server-side validation
- Vitest + PGlite for database and calculation tests
- Vercel deployment

Planned stack additions are introduced only in their sprint: PDF rendering in Sprint 3.5A,
Resend email in Sprint 3.5B, Clerk Billing/Stripe in Sprint 4, and vision/AI extraction in
Sprint 4.7.

## Multi-tenant architecture

PrepProfit uses two independent isolation layers:

1. Application layer: `organization_id` comes from Clerk on the server via `getOrgId()`.
   Data access helpers explicitly scope every query by organization.
2. Database layer: every business table is listed in `businessTables` and receives RLS
   with `FORCE ROW LEVEL SECURITY`. `withOrg()` sets `app.current_org_id` per transaction.

Writes run inside `withOrg(...)`, so RLS `USING` and `WITH CHECK` policies are active.
Tests cover both reads and write rejection paths.

Money is stored as integer cents. Physical quantities may use numeric canonical units.

## Getting started

```bash
npm install
npm test
```

To run the app against Neon and Clerk, fill `.env.local` using `.env.example`, then:

```bash
npm run db:migrate
npm run seed:org   # optional, for a real Clerk org id
npm run dev
```

See [SETUP.md](SETUP.md) for the full local and production setup.

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript check |
| `npm test` | Vitest + PGlite test suite |
| `npm run db:generate` | Generate Drizzle migration |
| `npm run db:migrate` | Apply migrations and RLS policies |
| `npm run seed` | Seed demo data for two env-provided org ids |
| `npm run seed:org` | Seed one active Clerk organization |
| `npm run seed:demo` | Seed richer demo data for one org |

## Testing

The suite verifies calculation correctness, org isolation, RLS, RBAC, soft-delete behavior,
search filtering, invoice numbering, inventory ledger behavior, and critical Server Actions.
PGlite keeps tests local and credential-free. Some real-concurrency guarantees still need a
Postgres job before launch; those are tracked in [PLANO.md](PLANO.md).

## Deployment

Deploy on Vercel with Neon Postgres and Clerk Organizations enabled. Run production migrations
before the first deploy and after every migration merge. Vercel does not run migrations for you.

Required production checks:

- `DATABASE_URL` points at the intended Neon branch/database.
- Clerk keys and URLs are set for the environment.
- `CRON_SECRET` is set before enabling scheduled purge.
- `npm run db:migrate` completes and the expected columns/tables exist in Neon.
- CI gates pass: lint, typecheck, tests, and `next build`.

## Roadmap

[PLANO.md](PLANO.md) is the source of truth. Current sequence:

- [x] Sprint 0 - Multi-tenant foundation
- [x] Sprint 1 - Recipes, ingredients, units, inventory
- [x] Sprint 1.5 - Trash and purge foundation
- [x] Sprint 1.6 - Recipe folders
- [x] Sprint 1.7 - Hardening baseline
- [x] Sprint 2 - Financials and break-even
- [x] Sprint 2.7 - Global search
- [x] Sprint 3 - Invoices and payroll data/builders
- [ ] Sprint 3.1 - Production hardening
- [ ] Sprint 3.5A - Document foundation and invoice PDF
- [ ] Sprint 3.5B - Reports, Excel exports, and document email
- [ ] Sprint 4 - Billing and entitlements
- [ ] Sprint 4.5 - Deterministic import foundation
- [ ] Sprint 4.6 - Recipe import
- [ ] Sprint 4.7 - AI photo recipe extraction
- [ ] Sprint 5 - Launch readiness
- [ ] Sprint 6 - Kitchen operations tasks, if prioritized

---

<div align="center"><sub>Project rules in <a href="CLAUDE.md">CLAUDE.md</a> - Execution plan in <a href="PLANO.md">PLANO.md</a> - Design system in <a href="DESIGN.md">DESIGN.md</a></sub></div>
