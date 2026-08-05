# Production operations runbook (Sprint 5g)

Operational reference for running PrepProfit in production (Hetzner VPS + Coolify + Neon
+ Clerk). Pair this with `SETUP.md` (local/dev) and `docs/data-retention.md` (GDPR).

> **Migrated off Vercel on 2026-08-04.** The app now self-hosts. Anything that used to be
> a platform feature — cron scheduling, TLS certificates, env var injection — is now
> explicit configuration in Coolify. `vercel.json` was deleted; it is no longer read by
> anything. Vercel Blob is the ONE Vercel service still in use (recipe photos).

## Environments

- **Hosting**: Hetzner VPS (4 GB), deployed with **Coolify** (Nixpacks build pack) from
  `main`. Domain `prepprofit.com` (apex). `www` is registered as a second domain with
  Direction = *Redirect to non-www*, so both hostnames hold a Let's Encrypt certificate
  and `www` 302s to the apex. **The apex is the only canonical origin** — Clerk, `APP_URL`,
  the CSP and the webhook all point at it.
- **Database**: Neon Postgres (`neondb`), project in **`eu-central-1`** (same region as the
  VPS). Use the **pooled** connection string for the app, and the **`app_runtime`** role —
  see [Database roles](#database-roles).
- **Auth/billing**: Clerk (live instance) + Clerk Billing backed by live Stripe.
- **Email**: Resend (`prepprofit.com` verified, send-only key).

## Required environment variables (Production)

Set in Coolify → application → **Environment Variables**.

> **Build-time vs runtime — the trap that caused a production outage.** Next.js inlines
> every `NEXT_PUBLIC_*` into the bundle at **build** time. In Coolify a variable is
> runtime-only unless its **Build Variable** checkbox is ticked, so a `NEXT_PUBLIC_*` set
> as runtime-only is silently ignored and the previously baked value keeps shipping.
> Worse, Coolify **skips the build entirely when the commit SHA has not changed**
> (`Build step skipped`, image reused) — so changing a `NEXT_PUBLIC_*` and redeploying
> does nothing. To change one: tick Build Variable **and** force a rebuild without cache.
> Runtime-only vars (`DATABASE_URL`, `CLERK_SECRET_KEY`, `CRON_SECRET`, …) apply on a
> plain restart. Values are stored literally: a stray quote or space breaks them —
> `Publishable key not valid` in `middleware.js` means malformed, not missing.

| Var | Purpose | Notes |
|---|---|---|
| `DATABASE_URL` | Neon pooled connection, role `app_runtime` | Required. Validated lazily; bad value 500s data pages. **Never the owner string** — see [Database roles](#database-roles). |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Clerk auth | Live keys. |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Verify `/api/webhooks/clerk` | From Clerk → Webhooks. |
| `CRON_SECRET` | Authorize the purge cron | `openssl rand -hex 32`. |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | Document + lifecycle email | Optional feature; `RESEND_FROM_NAME`/`RESEND_REPLY_TO` optional. |
| `APP_URL` | Absolute base URL for email links/assets | Optional; `https://` in prod (localhost allowed in dev). Missing/invalid → emails render logo-less + omit CTAs. Never load-bearing. |
| `AI_COST_REPORT_EMAIL` | Weekly AI-spend report recipient | Optional; unset → the report cron skips quietly. |
| `GEMINI_API_KEY` | AI photo extraction | Optional; missing → `AI_EXTRACTION_FAILED`. |
| `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` | Error monitoring (5a) | Optional, fail-open. |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | Source-map upload (5a) | Build-time only. |
| `POSTHOG_KEY`, `POSTHOG_HOST` | Product analytics (5c) | Optional, fail-open. |
| `COMPED_ORG_IDS` | Operator full-access allowlist | Optional, comma-separated org ids. |
| `BLOB_READ_WRITE_TOKEN` | Recipe photos (private Vercel Blob) | **Now required.** On Vercel the SDK authenticated via OIDC automatically; self-hosted there is no OIDC, so the token must be set explicitly or every media operation fails. |
| `USDA_FDC_API_KEY` | USDA nutrition search | Optional; unset → `USDA_NOT_CONFIGURED`, custom profiles only. |
| `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_FLOWS_ORGANIZATION_ID`, `NEXT_PUBLIC_CRISP_WEBSITE_ID` | Browser SDKs | Optional, fail-open — but **build-time**: they must be ticked as Build Variables. |

All feature vars are **lazy + fail-open** except `DATABASE_URL` and the Clerk keys — never
add a feature var to `serverEnvSchema`. Secrets are never logged.

## Database roles

Two roles, on purpose — this is what makes RLS real in production (2026-08-04):

| Role | Used by | BYPASSRLS | Connection string |
|---|---|---|---|
| `app_runtime` | the app at runtime (`DATABASE_URL` in Coolify) | **no** | pooled host |
| `neondb_owner` | migrations, admin/backfill scripts, `psql` surgery | yes | direct host (no `-pooler`) |

`neondb_owner` has `rolbypassrls = true`, which **overrides `ENABLE`/`FORCE ROW LEVEL
SECURITY`**: while the app ran as the owner, the policies in `lib/db/rls.ts` filtered
nothing, and `select count(*) from recipes` without the `app.current_org_id` GUC returned
every org's rows. Rule 1 (an explicit `organization_id` filter on every query) was the only
thing holding tenancy up. `app_runtime` is `NOBYPASSRLS`, so the policies actually apply and
the second layer of defense exists.

- The runtime role owns nothing and has only `SELECT, INSERT, UPDATE, DELETE` on
  `public`. `ALTER DEFAULT PRIVILEGES` (set as the owner, who creates tables in
  migrations) grants the same on tables created later — a new sprint's table needs no
  manual GRANT.
- **Migrations must run as the owner**: `DATABASE_URL=<owner-direct> npm run db:migrate`.
  `app_runtime` cannot create or alter anything, by design. Same for
  `scripts/backfill-recipes-v2.ts` and `scripts/verify-recipes-v2-parity.ts`, whose
  `lib/db/org-enumeration.ts` deliberately reads across orgs and therefore *needs* bypass.
- Consequences to expect, all intended: a write tagged with the wrong org now **errors**
  (`42501`, `WITH CHECK`) instead of being stored, and `audit_log` / `inventory_movements`
  are append-only for real — UPDATE and DELETE match zero rows. Purging an ingredient still
  removes its movements, because an FK cascade is a referential action, not an RLS-checked
  DELETE.
- Rollback is a credential swap: point `DATABASE_URL` back at the owner string and restart.
  No data diverges.
- `app_runtime` was created with SQL, so it does **not** appear under Neon → Roles and has
  no console password reset. Rotate it as the owner:
  `ALTER ROLE app_runtime PASSWORD '<new>'`, then update Coolify and restart.
- **Two guards keep this from regressing silently** (`docs/rls-regression-guard-plan.md`):
  - **At boot**, `instrumentation.ts` asks the database whether the connected role has
    `BYPASSRLS` and, if it does, logs an error to the container log and Sentry under
    `runtimeRoleBypassesRls`. It is fail-open: it reports, it never blocks startup.
  - **At migrate time**, `npm run db:migrate` verifies that `app_runtime` exists, is
    `NOBYPASSRLS`, holds SELECT/INSERT/UPDATE/DELETE on every business + infra table, and
    that RLS is enabled *and* forced with at least one policy on every business table. A
    gap fails the command with the exact `GRANT` to run. This is what catches a new
    sprint's table that never got a grant — before a user meets `permission denied`.
    On a database without the role (dev, CI, a fresh branch) it warns and skips; set
    `EXPECT_APP_RUNTIME_ROLE=1` to make the absence an error instead.
- Isolation against real Postgres with a `NOBYPASSRLS` login role is covered by an opt-in
  test, `tests/concurrency/rls-real-role.pg.test.ts`, gated on `TEST_DATABASE_URL_APP`
  (that file's header has the branch + role setup). Note this is *not* what the in-suite
  RLS tests lack — those already run under `SET ROLE tenant_app` and exercise the policies
  properly; what the real-Postgres run adds is a login role and the GRANTs, which PGlite
  does not model.

## Migrations

- Run as **`neondb_owner`** (the runtime role has no DDL rights).
- Generate with `npm run db:generate`, **verify journal ordering** (a new migration's
  `when` must be greater than the previous max, or `scripts/migrate.ts`'s guard silently
  skips it — the recurring "journal-when" gotcha).
- Apply to prod: `DATABASE_URL=<owner-direct> npm run db:migrate` (idempotently re-applies RLS).
  Pass it inline — it is **not** the string in Coolify.
- **Verify after deploy**: confirm `drizzle.__drizzle_migrations` max `created_at` matches the
  newest migration, and spot-check the new columns/tables + that RLS is `enabled + forced`.
- Current head: **0045**. RLS is `enabled + forced` on every business table at this head.
- The database did **not** move during the Vercel→Coolify migration. It moved afterwards, on
  2026-08-04, to a Neon project in `eu-central-1`: the old `us-east-1` project cost ~107 ms
  per round-trip from the VPS, so a `withOrg` transaction (4 round-trips) spent ~430 ms on
  network alone.

## Scheduled jobs (Coolify Scheduled Tasks)

There are **six** cron routes. All are `GET`, all live under `app/api/cron/*`, all are
public in `middleware.ts` (no Clerk session) and all authenticate with `CRON_SECRET` as
`Authorization: Bearer <secret>`, compared in constant time by `lib/cron-auth.ts`.
Unauthorized → `401`. Each also passes a rate-limit bucket (`lib/rate-limit/config.ts`,
5/minute) keyed by a SHA-256 hash of the auth header — so manual retries in quick
succession legitimately return `429`.

They run as **Coolify → application → Scheduled Tasks**, one task per route:

| Task name | Schedule (UTC) | Route |
|---|---|---|
| `purge-trash` | `0 4 * * *` | `/api/cron/purge-trash` |
| `cfo-report` | `0 4 * * 1` | `/api/cron/cfo-report` |
| `email-outbox` | `30 4 * * *` | `/api/cron/process-email-outbox` |
| `ai-cost-report` | `0 6 * * 1` | `/api/cron/ai-cost-report` |
| `trial-reminder` | `0 8 * * *` | `/api/cron/trial-reminder` |
| `sweep-recipe-media` | `45 4 * * *` | `/api/cron/sweep-recipe-media` |

The **Command** field of each task (the *Name* field is only a label — putting the route
name there instead yields `sh: 1: <name>: not found`):

```
node -e 'fetch("https://prepprofit.com/api/cron/<route>",{headers:{Authorization:"Bearer "+process.env.CRON_SECRET}}).then(async r=>{console.log(r.status,await r.text());if(!r.ok)process.exit(1)})'
```

Notes on that command: `node` is used rather than `curl` because Node is guaranteed in the
container (it is the app runtime) and `curl` is not. Single quotes outside / double inside
so the shell passes the script through untouched. The secret is **never** pasted into the
task — it is read from the container's own env, so rotating the variable re-syncs all six.
`process.exit(1)` makes Coolify mark a failed run as failed instead of silently succeeding.

**Differences from Vercel Cron** (which used to send the Bearer token automatically):
tasks only fire while the container is running, and **there is no automatic retry** for a
missed window. `purge-trash` and `process-email-outbox` are idempotent, so a skipped day
self-heals the next run. Schedules are interpreted by the Coolify scheduler on the host
(it schedules, then `docker exec`s), so the authority for timezone is Coolify →
Settings → instance timezone, not the container's `date` (both are UTC today).

What each one does:

- **`purge-trash`** — hard-deletes trash past the retention window, per org, inside
  `withOrg` (RLS active), auditing each purge. Also emits the Sprint 5d low-stock digest
  when email is configured. Pages orgs **via the Clerk Backend API**, so it is also a good
  end-to-end signal that the live Clerk keys work. **Destructive and irreversible** — do
  not fire it manually to "test".
- **`cfo-report`** — queues one deterministic `cfo_report` row in `email_outbox` per
  opted-in, paid, business-email org that has data. Deterministic only; it NEVER calls an
  AI provider. Idempotent per week via the outbox unique `(organization_id, dedup_key)`.
  Opt-in is the manager-only Notifications toggle in `/settings` (default OFF).
- **`process-email-outbox`** — delivers queued purchase-order and `cfo_report` rows with
  at-least-once + provider-dedup semantics; a row with a `provider_message_id` is never
  resent. Requires `RESEND_*`; skips quietly when email is unconfigured.
- **`ai-cost-report`** — emails `AI_COST_REPORT_EMAIL` a per-org Gemini spend digest.
  **The only cron with no side effect when unconfigured**: with the recipient unset it
  returns `{"ok":true,"skipped":"report-not-configured"}` without sending, which makes it
  the safe route for verifying `CRON_SECRET`. With the recipient set it does send.
- **`trial-reminder`** — reminds orgs whose 14-day reverse trial is about to end. Sends to
  real customers; the single-calendar-day window assumes UTC.
- **`sweep-recipe-media`** — removes bucket objects for `pending`/`rejected` uploads and
  soft-deleted media past the cutoff, then hard-deletes exactly the rows whose objects were
  removed. Note `swept: 0` proves **nothing** about Blob connectivity: `storage.remove()` is
  only called when there are candidate rows.

**Verifying the setup**: use the `ai-cost-report` task's manual *Run* and expect
`200 {"ok":true,...}` in its log. Since signature/auth handling is identical across all
six, one green run validates the mechanism for all of them — do not "test" the other five,
as every one of them purges data or sends real email.

## Backups & recovery (Neon)

- Neon retains point-in-time history (PITR). Confirm the retention window on the plan.
- To restore: create a branch at a timestamp, validate, then repoint `DATABASE_URL`.
- **Erasure caveat**: a GDPR hard-delete is only fully complete once PITR/backup windows roll
  past it — state the window when answering an erasure request (see `docs/data-retention.md`).

## Webhooks

- Clerk → `https://prepprofit.com/api/webhooks/clerk` (Svix). Signature-verified with
  `CLERK_WEBHOOK_SIGNING_SECRET`; a bad signature → 400, no DB touch. The `subscriptions`
  mirror is read-only observability and never gates access.
- **Use the apex, never `www`.** Svix validates TLS. The endpoint sat on
  `https://www.prepprofit.com/...` for a month after the migration and would have failed
  every delivery with a self-signed-certificate error, because Coolify had only issued a
  certificate for the apex. It went unnoticed purely because no event fired in that window.
  `www` now has its own certificate, but the endpoint stays on the apex.
- The signing secret is **per endpoint**: recreating an endpoint instead of editing it
  changes `whsec_…` and every delivery starts returning 400 until Coolify is updated.
- Subscribed events (10, must match the handler in `app/api/webhooks/clerk/route.ts`):
  `organization.created` / `.updated` / `.deleted`, `organizationMembership.created` /
  `.updated` / `.deleted`, `subscription.created` / `.updated` / `.active` / `.pastDue`.
  Note it listens to `subscription.*`, **not** the finer-grained `subscriptionItem.*`.
- **Never use `organization.created` as a test event.** That branch is deliberately not
  best-effort: it writes real rows for the payload's fake org id, then throws on
  `updateOrganizationMetadata` for an org that does not exist, returns 500 and makes Svix
  retry. Test with an unhandled type such as `user.created` — verification happens before
  any branching, so any event type proves the secret while writing nothing.

## Secret rotation

1. Generate the new secret at the provider (Clerk/Resend/Neon/Sentry/PostHog/Gemini).
2. Update the variable in Coolify and restart (runtime vars need no rebuild; a
   `NEXT_PUBLIC_*` needs Build Variable + a forced rebuild — see the env var section).
3. Revoke the old secret at the provider. Rotate `CRON_SECRET` + the Clerk webhook secret on a
   schedule. Never commit secrets; `.env.local` is gitignored.

## Observability & incident response

- Errors flow through `logError` (`lib/observability.ts`) → structured `console.error` with an
  `eventId` **and** Sentry (5a), tagged with that id. Read container logs in Coolify
  (application → Logs) and cross-link to the Sentry issue by `eventId`. Scheduled-task
  output has its own per-run log under Scheduled Tasks. No PII in logs/audit metadata.
- High-risk mutations append to `audit_log` (append-only). Use it to reconstruct what happened
  per org. Rate limiting (`rate_limits`) protects abuse-prone routes.

## Pre-launch checklist

- [ ] All env vars set in Coolify, `NEXT_PUBLIC_*` ticked as Build Variables; a fresh
      deploy is green and `curl -s https://prepprofit.com/sign-in | grep -o 'pk_[a-z]*_'`
      returns `pk_live_`.
- [ ] Migrations applied + verified (head 0045); RLS enabled + forced on every business table.
- [ ] All six Scheduled Tasks exist with the full `node -e …` command; `ai-cost-report`
      returns 200 on a manual run.
- [ ] Clerk webhook endpoint on the **apex** + secret set; a `user.created` test event is accepted.
- [ ] Sentry receiving events (trigger a throw in a non-prod env to confirm).
- [ ] Resend domain verified; a test document email delivers.
- [ ] Billing: a test org can subscribe to Pro and unlock features; comped org has access.
- [ ] Data export downloads; a deletion request is recorded and visible to the operator query.
- [ ] CI green (lint, typecheck, tests, build); E2E smoke enabled if `RUN_E2E` secrets are set.
