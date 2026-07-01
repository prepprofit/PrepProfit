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

The core product (Sprints 0–5) is built and in production: billing, document/PDF/XLSX
generation, transactional email, deterministic imports, reviewed AI photo recipe
extraction, and launch operations are all shipped. See [PLANO.md](PLANO.md).

The current focus is the **AI margin-protection** track — turning the financial data already
in the product into proactive, chef-friendly insight. The guiding principle is deterministic
first: the math that produces a money number is always pure and tested, and AI is used only to
*read messy inputs* (invoices, photos) and to *explain* findings — never to invent a margin,
a cost, or a price. See the roadmap below and
[the implementation plan](docs/prepprofit_ai_implementation_plan_senior_revised.md).

## Product modules

| # | Module | Current scope |
|---|--------|---------------|
| 1 | Recipes | Cost, yield/loss, hidden costs, margin, folders, trash, live batch scaling + prep cards |
| 2 | Ingredients & suppliers | Ingredients, supplier links with purchase packs, observed-cost pricing |
| 3 | Financials | Transactions, categories, CSV export, monthly/annual dashboard |
| 4 | Inventory | Stock movements, authoritative ledger, low-stock thresholds |
| 5 | Break-even | Scenario simulator with safe zero/negative-margin handling |
| 6 | Payroll | Employees, shifts, period summaries, manager-only |
| 7 | Invoices | Customers, draft/issue/pay/void lifecycle, gap-free numbering |
| 8 | Kitchen ops | Menus, productions, sales, and gap-free purchase orders |
| 9 | Documents | Print, PDF, XLSX, and emailed outputs (invoices, recipe cards, P&L, payroll) |
| 10 | Imports | Deterministic staged CSV/XLSX import of ingredients, transactions, and recipes |
| 11 | AI photo extraction | Reviewed recipe drafts from photos (Gemini): no-loss editable workbench, supplier-pack inference, never auto-priced |
| 12 | Global search | Typo-tolerant search across allowed entities with RBAC |
| 13 | Tasks | Kitchen operations task lists |
| 14 | Profit Leak Detector | Deterministic dashboard surfacing recipes, menus, and ingredients hurting margin right now — manager-only, no LLM |

Backlog (not scheduled until prioritized): advanced multi-image/OCR extraction, saved
reports, recurring checklists, and persisted recipe scaling. See [PLANO.md](PLANO.md).

## Stack

Active stack:

- Next.js 15 App Router, React 19, strict TypeScript
- PostgreSQL on Neon with Drizzle ORM
- Clerk auth with Organizations and org roles, Clerk Billing + Stripe for subscriptions
- Tailwind CSS v4, shadcn/ui patterns, Recharts
- next-intl for UI copy and action error messages
- Zod for server-side validation
- `@react-pdf/renderer` for PDFs, `write-excel-file` for XLSX, Resend for email
- Google Gemini for reviewed AI photo recipe extraction (behind a mockable wrapper)
- Sentry + PostHog for observability/analytics, Playwright for E2E smoke tests
- Vitest + PGlite for database and calculation tests
- Vercel deployment

The stack is current as of the launch-readiness sprint; earlier "planned in sprint X"
additions (PDF, email, billing, vision/AI) are all shipped.

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
| `npm run eval:extraction` | Run the AI photo-extraction eval set against the live provider (needs `GEMINI_API_KEY`) |

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

[PLANO.md](PLANO.md) is the source of truth. Sprints 0–5 are complete and in production:

- [x] Sprint 0 - Multi-tenant foundation
- [x] Sprint 1 - Recipes, ingredients, units, inventory
- [x] Sprint 1.5 - Trash and purge foundation
- [x] Sprint 1.6 - Recipe folders
- [x] Sprint 1.7 - Hardening baseline
- [x] Sprint 2 - Financials and break-even
- [x] Sprint 2.7 - Global search
- [x] Sprint 3 - Invoices and payroll data/builders
- [x] Sprint 3.1 - Production hardening (rate limiter, audit log, concurrency proof)
- [x] Sprint 3.5A - Document foundation and invoice PDF
- [x] Sprint 3.5B - Reports and Excel exports
- [x] Sprint 3.5C - Document email (Resend)
- [x] Sprint 4 - Billing, entitlements, and organization lifecycle
- [x] Sprint 4.5 - Deterministic import foundation
- [x] Sprint 4.6 - Recipe import and ingredient resolver
- [x] Sprint 4.7 - AI photo recipe extraction (Gemini), with a 20-photo eval gate
- [x] Sprint 5 - Launch readiness and beta operations
- [ ] Sprint 6 - Kitchen operations tasks, if prioritized by beta feedback

Also shipped outside the numbered sprints: a kitchen-ops module set (suppliers, menus,
productions, sales, purchase orders) and live recipe batch scaling.

### AI margin-protection track (current focus)

Positioning: *AI margin protection for small kitchens.* Value-ordered, deterministic-first.
Full detail in [the implementation plan](docs/prepprofit_ai_implementation_plan_senior_revised.md).

| # | Sprint | User-visible value | Status |
|---|--------|--------------------|--------|
| 1 | Profit Leak Detector (no LLM) | Surfaces recipes, menus, and ingredients hurting margin right now | ✅ Shipped |
| 2 | Supplier Invoice Reader | Upload an invoice; AI turns lines into reviewed price *observations* (never approved costs) | ✅ Shipped |
| 3 | Invoice → Profit Impact Loop | Shows which recipes/menus fall under margin after a cost change | ✅ Shipped |
| 4 | AI Explanations + Profit Insight Inbox | Explains deterministic findings in chef-friendly language | ✅ Shipped |
| 5 | Menu Engineer | Classifies items by popularity and profitability | ✅ Shipped |
| 6 | Daily Close Summary | Explains posted sales and food-cost anomalies | Planned |
| 7 | Prep / Reorder Planner | Suggests prep and reorder tasks from recipes and stock | Planned |
| 8 | Weekly CFO Report → chat | Premium management layer over trusted insights | Planned |

**Sprint 1 — Profit Leak Detector** is live: a pure, tested detection engine
([`lib/calculations/profit-leaks.ts`](lib/calculations/profit-leaks.ts)) reusing the existing
cost/margin/menu modules, an org-scoped loader ([`lib/data/profit-leaks.ts`](lib/data/profit-leaks.ts)),
and a manager-only dashboard card. It detects below-target recipe and menu margins, unpriced
ingredients in active recipes/menus, and pending-price impact — with hard honesty rules: an
unpriced line suppresses any margin claim, and an incomplete menu never shows a fake margin.

**Sprint 5 — Menu Engineer** is live: a pure, tested classifier
([`lib/calculations/menu-engineering.ts`](lib/calculations/menu-engineering.ts)) that drops each
sold item into the classic star / puzzle / workhorse / dog matrix. Both axes are relative to the
org's own sales in the period — average units sold (popularity) and average per-unit contribution
margin in cents (profitability) — never a global magic number. An org-scoped loader
([`lib/data/menu-engineering.ts`](lib/data/menu-engineering.ts)) joins current catalogue cost with
posted-sale volume (draft/void excluded), and a manager-only page renders the matrix. The same
honesty rules hold: an item with no selling price or an unavailable cost is set aside as *needs
pricing*, never given a fabricated margin. No LLM call.

Non-negotiable rules for every sprint in this track:

- AI is never the source of financial truth — deterministic math first, AI only reads inputs or explains.
- Human review before any write; AI output is staged, validated with Zod, and confirmed by a manager.
- Financial AI is manager-only; raw invoice/image/model content is never logged.

---

<div align="center"><sub>Project rules in <a href="CLAUDE.md">CLAUDE.md</a> - Execution plan in <a href="PLANO.md">PLANO.md</a> - Design system in <a href="DESIGN.md">DESIGN.md</a></sub></div>
