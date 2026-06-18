# SETUP - PrepProfit

This guide covers local development and production setup for the current PrepProfit app.
The automated tests do not require Neon or Clerk; they run against PGlite.

## 0. Prerequisites

- Node 22+
- npm 10+
- A Neon Postgres project for real app runs
- A Clerk application with Organizations enabled

Install dependencies:

```bash
npm install
```

Run the local test suite without credentials:

```bash
npm test
```

## 1. Neon database

1. Create a Neon project.
2. Copy the pooled connection string. The pooled host usually contains `-pooler`.
3. Put it in `.env.local` as `DATABASE_URL`.

Use separate Neon branches/projects for local development, preview, and production when possible.

## 2. Clerk authentication and organizations

1. Create a Clerk application.
2. Enable Organizations.
3. Use membership-required/B2B behavior for the production app.
4. Copy:
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
   - `CLERK_SECRET_KEY`
5. Configure the sign-in/sign-up/select-organization URLs to match the app routes.

Roles:

- Clerk `org:admin` maps to PrepProfit `manager`.
- Other org roles map to `kitchen`.

Managers can access financials, invoices, payroll, trash, settings, exports, generated
documents, billing, and AI extraction usage controls. Kitchen users can access operational
surfaces only.

## 3. Environment variables

```bash
cp .env.example .env.local
```

Required now:

- `DATABASE_URL`
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`

Required when scheduled purge is enabled:

- `CRON_SECRET`

Optional (tests only):

- `TEST_DATABASE_URL` - a disposable Neon branch for the opt-in real-Postgres
  concurrency proof (`tests/concurrency/recipe-line.pg.test.ts`). PGlite is a single
  connection and cannot exercise concurrent `SELECT … FOR UPDATE`, so that test is
  skipped unless this is set. To run it: migrate the branch first
  (`DATABASE_URL=<branch-url> npm run db:migrate`), then
  `TEST_DATABASE_URL=<branch-url> npm test`. Never point it at production.

Planned later:

- Billing/webhook secrets in Sprint 4
- Resend/email secrets in Sprint 3.5B
- AI provider key in Sprint 4.7
- Sentry/PostHog secrets in Sprint 5

## 4. Migrations and RLS

Run migrations against the selected database:

```bash
npm run db:migrate
```

This applies Drizzle migrations and then applies RLS statements generated from
`businessTables`.

Production checklist after every migration:

- Confirm the command did not abort on migration journal ordering.
- Verify new tables/columns exist in Neon.
- Verify new business tables are in `businessTables` and have RLS enabled/forced.
- Run the full CI gate before deployment.

## 5. Seed data

For one real Clerk organization:

```bash
SEED_ORG=org_xxxx npm run seed:org
```

PowerShell:

```powershell
$env:SEED_ORG="org_xxxx"
npm run seed:org
```

For two-org isolation demos, use the seed script that reads two org ids:

```bash
SEED_ORG_A=org_xxxxA SEED_ORG_B=org_xxxxB npm run seed
```

PowerShell:

```powershell
$env:SEED_ORG_A="org_xxxxA"
$env:SEED_ORG_B="org_xxxxB"
npm run seed
```

The seed scripts must only delete/count rows scoped to the provided organization ids.

## 6. Run locally

```bash
npm run dev
```

Open http://localhost:3000.

Recommended manual smoke:

- Create/switch between two Clerk organizations.
- Verify each org sees only its own recipes, ingredients, financials, invoices, and payroll.
- Verify a manager can access financial/invoice/payroll/settings/trash surfaces.
- Verify a kitchen user is blocked from manager-only pages and actions.

## 7. Cron purge

The trash purge route requires `CRON_SECRET`. Without it, the route fails closed.

For production, set the secret in Vercel and configure the scheduled route only after migrations
and env vars are verified.

## 8. Deployment on Vercel

1. Import the repository.
2. Set environment variables for the target environment.
3. Run production migrations manually against the production Neon database.
4. Deploy.
5. Confirm scheduled cron, Clerk URLs, and org switching work in production.

Vercel does not run database migrations automatically.

## Useful commands

| Action | Command |
|--------|---------|
| Dev server | `npm run dev` |
| Full local gate | `npm run lint && npm run typecheck && npm test && npm run build` |
| Generate migration | `npm run db:generate` |
| Apply migrations + RLS | `npm run db:migrate` |
| Unit/integration tests | `npm test` |
| Seed one org | `npm run seed:org` |
| Seed demo org | `npm run seed:demo` |
