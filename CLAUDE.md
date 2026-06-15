# PrepProfit SaaS — Project Rules

## What this project is
Multi-tenant SaaS for financial management aimed at chefs and food-business owners
(restaurants, bakeries, patisseries). It replaces a spreadsheet kit with a
subscription web app. Initial codebase: built fresh from the Wibox base
(Next.js), cherry-picked where it made sense.

## Stack (do not change without explicit approval)
- Next.js 15 (App Router) + React 19 + strict TypeScript
- PostgreSQL on Neon + Drizzle ORM
- Clerk (auth + Organizations) and Clerk Billing connected to Stripe
- Tailwind CSS + shadcn/ui (incl. shadcn/ui charts on Recharts, for dashboards)
- TanStack Table (editable grids), react-pdf (invoices)
- Resend (emails), next-intl (i18n: English to start; more locales later)
- Deploy: Vercel

## RULE #1 — Multi-tenancy (non-negotiable)
- EVERY business-data table has an `organization_id` column (text, from Clerk).
- EVERY query (select, insert, update, delete) filters by `organization_id`.
- Never trust `organization_id` coming from the client. Always derive it on the
  server via Clerk's `auth()` (Server Action or Route Handler).
- Use the `getOrgId()` helper in `lib/auth.ts` for all data access.
- A query without an org filter is a security bug: stop and fix it.

## Code rules
- Server Actions for mutations; no unnecessary API routes.
- Zod validation on all user input (server, not just client).
- Monetary values: store as integer cents. Never float.
- Cost/margin/break-even calculations as pure functions in `lib/calculations/`
  with unit tests (Vitest). These calculations are the heart of the product.
- Components: shadcn/ui first; build custom only when necessary.
- No `any`. No `@ts-ignore`. Types derived from the Drizzle schema.
- UI strings always via next-intl, never hardcoded.

## Product modules (parity with the original spreadsheet kit)
1. Recipe cost calculator (ingredients → total cost, per portion, margin)
2. Financial panel: income, expenses, monthly/annual dashboard
3. Ingredient and recipe inventory (in/out, low-stock alert)
4. Break-even calculator (with scenario simulations)
5. Payroll: shifts, hours, per-employee pay
6. PDF invoice generator

## Subscription plans (gating via Clerk `has()`)
- Starter: 1 user, up to 50 recipes, modules 1–3
- Pro: 5 users, unlimited recipes, modules 1–4 + invoices
- Business: unlimited users, all modules incl. payroll

## Workflow
- Follow PLANO.md sprint by sprint. Do not skip steps.
- Before each sprint: enter plan mode, propose the plan, wait for approval.
- When a task is done: mark it `[x]` in PLANO.md.
- Small, frequent commits with English messages (conventional commits).
- Run `npm run lint && npm run typecheck && npm test` before every commit.
- Never commit secrets. `.env.local` is gitignored.

## Commands
- dev: `npm run dev`
- build: `npm run build`
- tests: `npm test`
- migrations: `npx drizzle-kit generate` and `npm run db:migrate`
