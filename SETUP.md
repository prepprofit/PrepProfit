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

Organization self-delete lockdown (Sprint 4e):

- PrepProfit is one organization per customer, and customers must not delete their own org.
- This is enforced at the instance level by `organization_settings.admin_delete_enabled = false`
  (applied to both the development and production instances). It disables org deletion for all
  admins regardless of role permissions, so no custom role or reserved system user is required.
- Set it via the Clerk CLI, e.g.:
  `clerk config patch --json '{"organization_settings":{"admin_delete_enabled":false}}'`
  (add `--instance <prod-instance-id>` for production), or via the Clerk Dashboard.

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

Required when emailing documents is enabled (Sprint 3.5C):

- `RESEND_API_KEY` - Resend API key. A secret; never commit it and it is never logged.
- `RESEND_FROM_EMAIL` - the verified sender address, **bare email only** (e.g. `documents@yourdomain.com`). Do not include a display name here.
- `RESEND_FROM_NAME` (optional) - sender display name recipients see; composed into the `From` header as `Name <address>`. Defaults to `PrepProfit`.
- `RESEND_REPLY_TO` (optional) - reply-to address; set on outbound mail when present.

These are validated lazily (`emailEnv()` in `lib/env.ts`): the rest of the app runs without
them, and only the email send path requires them. A missing key surfaces as the stable
`EMAIL_FAILED` action error, never a leaked secret.

The same `RESEND_*` config also powers the Sprint 5d lifecycle emails — a welcome email on
organization creation and a daily low-stock digest (to the org's business email) from the
purge cron. These are best-effort: when Resend is unconfigured they are skipped silently
(`isEmailConfigured()`), never erroring.

Required when AI photo recipe extraction is enabled (Sprint 4.7):

- `GEMINI_API_KEY` - Google Gemini API key (Google AI Studio → API keys). A secret; never
  commit it and it is never logged. Validated lazily (`aiEnv()` in `lib/env.ts`): the rest
  of the app runs without it, and only the extraction route requires it. A missing/invalid
  key surfaces as the stable `AI_EXTRACTION_FAILED` action error, never a leaked secret.
  The model id is pinned in one place (`RECIPE_EXTRACTION_MODEL` in
  `lib/ai/recipe-extraction.ts`); swapping models is a one-line change there.

Optional (error monitoring, Sprint 5a):

- `SENTRY_DSN` - server/edge Sentry DSN. When unset, Sentry is a no-op (fail-open): the
  app behaves exactly as before, just console-only error logging. A DSN is not strictly
  secret but is read only from env.
- `NEXT_PUBLIC_SENTRY_DSN` - browser DSN (usually the same value). Inlined into the client
  bundle at build time; also fail-open when unset.
- `SENTRY_AUTH_TOKEN` (build/CI only) - uploads source maps so stack traces are readable.
  A secret; never commit it and it is never logged. Without it the build still succeeds,
  just without uploaded source maps.
- `SENTRY_ORG` / `SENTRY_PROJECT` (build/CI only) - target org/project for source-map upload.

  Sentry is wired through the existing `logError` seam (`lib/observability.ts`): every
  unexpected error is forwarded with its correlation `eventId` and no PII (`sendDefaultPii:
  false`). A forwarding failure can never escalate the original error.

Optional (operator/internal access):

- `COMPED_ORG_IDS` - comma-separated Clerk organization ids that are treated as the
  Business tier (all paid features, unlimited recipe cap) regardless of their Clerk
  billing state. Empty/unset by default, so customer billing is untouched. Use it to
  grant your own org full access without a paid subscription (e.g. when production
  Clerk Billing runs against live Stripe and you don't want to charge yourself). This
  is an explicit per-org allowlist read server-side (`lib/entitlements.ts`), NOT a
  role bypass — only the exact ids listed are affected; every other org still reads
  its real plan fail-closed.

Optional (tests only):

- `TEST_DATABASE_URL` - a disposable Neon branch for the opt-in real-Postgres
  concurrency proof (`tests/concurrency/recipe-line.pg.test.ts`). PGlite is a single
  connection and cannot exercise concurrent `SELECT … FOR UPDATE`, so that test is
  skipped unless this is set. To run it: migrate the branch first
  (`DATABASE_URL=<branch-url> npm run db:migrate`), then
  `TEST_DATABASE_URL=<branch-url> npm test`. Never point it at production.

Optional (Playwright E2E smoke, Sprint 5b):

- `npm run test:e2e` runs the launch smoke (`tests/e2e/smoke.spec.ts`). With no Clerk
  test instance configured it runs only the always-on public checks (landing + sign-in
  render) and passes. The authed manager + kitchen-RBAC specs skip themselves unless the
  vars below are set against a **Clerk TEST instance** (never production):
  - `CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` - the test instance keys (`@clerk/testing`
    exchanges the secret for a Testing Token so sign-in bypasses bot/CAPTCHA challenges).
  - `E2E_USER_EMAIL` / `E2E_USER_PASSWORD` - a seeded manager (`org:admin`) test user.
  - `E2E_KITCHEN_EMAIL` / `E2E_KITCHEN_PASSWORD` (optional) - a seeded kitchen member, to
    assert `/financials` renders NoAccess server-side.
  - `E2E_BASE_URL` (optional) - target an already-running/remote app instead of having
    Playwright build+start one locally.
  In CI the `e2e` job runs only when the repo **variable** `RUN_E2E == 'true'`; provide the
  same values as secrets prefixed `E2E_CLERK_PUBLISHABLE_KEY`/`E2E_CLERK_SECRET_KEY` plus
  `E2E_DATABASE_URL`, `E2E_USER_*`, and optional `E2E_KITCHEN_*`. Until then the job is
  skipped (never a red check). Dependency upgrades are automated via
  `.github/dependabot.yml` and a prod `npm audit --audit-level=high` CI step.

Required when billing webhooks are enabled (Sprint 4c):

- `CLERK_WEBHOOK_SIGNING_SECRET` - from Clerk Dashboard → Webhooks; verifies the
  billing webhook (`/api/webhooks/clerk`). Not used until slice 4c lands.

Planned later:

- PostHog analytics keys in Sprint 5c

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

## 7b. Billing and plans (Sprint 4)

PrepProfit uses **Clerk Billing for B2B organization plans** (Stripe handles payment only;
plans live in Clerk, not synced to Stripe). The plan/feature catalogue is version-controlled in
[`clerk/billing.json`](clerk/billing.json) and seeded with the Clerk CLI:

```bash
clerk enable billing --for orgs              # enable org billing (auto-creates free_org)
clerk config patch --file clerk/billing.json --dry-run   # preview
clerk config patch --file clerk/billing.json             # apply (dev instance)
clerk config patch --file clerk/billing.json --instance prod   # apply to production
```

The catalogue (Starter = the auto-created `free_org` baseline; `pro` / `business` are paid):

| Tier | Plan slug | Recipes (app cap) | Features (`has({ feature })`) |
|------|-----------|-------------------|-------------------------------|
| Starter | `free_org` | 50 | — (modules 1–3 only) |
| Pro | `pro` | unlimited | `invoices`, `break_even`, `ai_extraction` |
| Business | `business` | unlimited | + `payroll`, `advanced_documents` |

Notes:

- **Currency**: Clerk's dev gateway only accepts `usd`; the listed prices ($29 / $99) are
  **placeholders** — adjust in `clerk/billing.json` (or the Dashboard) before launch. The app's
  own money display currency (EUR, org settings) is unrelated to the subscription currency.
- **Recipe cap** (and seat limits) are enforced in the app (`lib/entitlements.ts`), keyed by the
  detected plan tier; entitlements read **fail-closed** (unknown state → Starter). Clerk's
  billing config has no per-plan seat field, so seat caps stay informational app-side until
  wired to the org membership limit (later slice).
- **Production**: connect a Stripe account once (Dashboard → Billing → Settings), then apply
  `clerk/billing.json` to the prod instance with `--instance prod`. Dev needs no Stripe account.

Slice 4c will add the billing webhook (`/api/webhooks/clerk`) requiring
`CLERK_WEBHOOK_SIGNING_SECRET`.

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
