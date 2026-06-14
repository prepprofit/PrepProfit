# SETUP — PrepProfit (Sprint 0)

Guide to get the multi-tenant foundation running. The automated tests
(`npm test`) need **none** of this — they use an in-memory Postgres. The steps
below are for running the real app and validating the acceptance criterion with
two real logins.

## 0. Prerequisites
- Node 22+
- `npm install` already run

## 1. Database — Neon
1. Create an account at https://neon.tech and a Postgres project.
2. In **Connection Details**, copy the **pooled connection string** (the host
   contains `-pooler`). The Pool is required for the transactions that activate
   RLS.
3. You'll paste it into `DATABASE_URL` (step 3).

## 2. Authentication — Clerk (with Organizations)
1. Create an account at https://clerk.com and an application.
2. **Organizations**: under **Organizations Settings**, enable
   *Enable organizations*, and pick **Membership required** (B2B-only — disables
   personal accounts; matches this app, which requires an active org and
   redirects to `/select-organization` when there is none).
3. In **API Keys**, copy:
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (starts with `pk_`)
   - `CLERK_SECRET_KEY` (starts with `sk_`)

## 3. Environment variables
```bash
cp .env.example .env.local
```
Fill `.env.local` with the `DATABASE_URL` (Neon) and the Clerk keys.
`.env.local` is gitignored — never commit secrets.

## 4. Migrations + RLS
```bash
npm run db:migrate
```
Creates the tables (`ingredients`, `recipes`, `recipe_ingredients`) and applies
the Row-Level Security policies (isolation by `organization_id`).

## 5. Seed two organizations (optional, for the acceptance-criterion demo)
Data is written per organization. For it to appear in the app, the ids must match
your real Clerk organization ids:
1. Run `npm run dev`, sign in, and create **two** organizations
   (e.g. "Bakery A" and "Patisserie B") in the OrganizationSwitcher.
2. Get each org id (format `org_...`) — visible in the Clerk dashboard
   (Organizations) or in the URL when selecting them.
3. Run the seed pointing at those ids:
   ```bash
   SEED_ORG_A=org_xxxxA SEED_ORG_B=org_xxxxB npm run seed
   ```
   (PowerShell: `$env:SEED_ORG_A="org_xxxxA"; $env:SEED_ORG_B="org_xxxxB"; npm run seed`)

## 6. Run
```bash
npm run dev
```
Open http://localhost:3000.

## 7. Validate the acceptance criterion (isolation between organizations)
- Sign in and switch between the two organizations in the top
  **OrganizationSwitcher**. Each organization only sees its own
  ingredients/recipes.
- For a **two-user** test: invite a second user (or use another browser/account)
  to Org B; they will never see Org A's data.
- Isolation is already guaranteed automatically in `npm test`
  (`tests/isolation.test.ts`), on both layers: `organization_id` scoping in the
  application **and** RLS in the database.

## 8. Deploy to Vercel
1. Import the `Napster13Nord/PrepProfit` repository at https://vercel.com.
2. Under **Environment Variables**, add the same keys as `.env.local`
   (`DATABASE_URL`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`,
   and the Clerk URLs). Re-deploy after adding them — `NEXT_PUBLIC_*` vars are
   baked in at build time.
3. The default build command (`next build`) works as-is.
4. **Before the first production deploy**, run the migrations against the
   production Neon: `npm run db:migrate` (with the production `DATABASE_URL`).
5. (Optional) Use a separate Neon project/branch for production vs development.

## Useful commands
| Action | Command |
|--------|---------|
| Dev | `npm run dev` |
| Lint + types + tests | `npm run lint && npm run typecheck && npm test` |
| Generate migration | `npm run db:generate` |
| Apply migrations + RLS | `npm run db:migrate` |
| Seed (2 orgs) | `npm run seed` |
