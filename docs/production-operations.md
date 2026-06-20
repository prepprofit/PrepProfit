# Production operations runbook (Sprint 5g)

Operational reference for running PrepProfit in production (Vercel + Neon + Clerk).
Pair this with `SETUP.md` (local/dev) and `docs/data-retention.md` (GDPR).

## Environments

- **Hosting**: Vercel project `prep-profit`. Production branch deploys `main`.
- **Database**: Neon Postgres (`neondb`). Use the **pooled** connection string for the app.
- **Auth/billing**: Clerk (live instance) + Clerk Billing backed by live Stripe.
- **Email**: Resend (`prepprofit.com` verified, send-only key).

## Required environment variables (Production)

Set in Vercel → Project → Settings → Environment Variables (Production scope).

| Var | Purpose | Notes |
|---|---|---|
| `DATABASE_URL` | Neon pooled connection | Required. Validated lazily; bad value 500s data pages. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Clerk auth | Live keys. |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Verify `/api/webhooks/clerk` | From Clerk → Webhooks. |
| `CRON_SECRET` | Authorize the purge cron | `openssl rand -hex 32`. |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | Document + lifecycle email | Optional feature; `RESEND_FROM_NAME`/`RESEND_REPLY_TO` optional. |
| `GEMINI_API_KEY` | AI photo extraction | Optional; missing → `AI_EXTRACTION_FAILED`. |
| `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` | Error monitoring (5a) | Optional, fail-open. |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | Source-map upload (5a) | Build-time only. |
| `POSTHOG_KEY`, `POSTHOG_HOST` | Product analytics (5c) | Optional, fail-open. |
| `COMPED_ORG_IDS` | Operator full-access allowlist | Optional, comma-separated org ids. |

All feature vars are **lazy + fail-open** except `DATABASE_URL` and the Clerk keys — never
add a feature var to `serverEnvSchema`. Secrets are never logged.

## Migrations

- Generate with `npm run db:generate`, **verify journal ordering** (a new migration's
  `when` must be greater than the previous max, or `scripts/migrate.ts`'s guard silently
  skips it — the recurring "journal-when" gotcha).
- Apply to prod: `DATABASE_URL=<prod-pooled> npm run db:migrate` (idempotently re-applies RLS).
- **Verify after deploy**: confirm `drizzle.__drizzle_migrations` max `created_at` matches the
  newest migration, and spot-check the new columns/tables + that RLS is `enabled + forced`.
- Current head: **0019** (`organization_settings` deletion-request columns, Sprint 5e).

## Scheduled jobs

- **Daily purge cron** → `GET /api/cron/purge-trash`, authorized by `CRON_SECRET` (Vercel Cron
  sends it as a Bearer token). Also emits the Sprint 5d low-stock digest when email is
  configured. Verify the Vercel Cron schedule exists and a manual hit returns `200` `{ ok: true }`.

## Backups & recovery (Neon)

- Neon retains point-in-time history (PITR). Confirm the retention window on the plan.
- To restore: create a branch at a timestamp, validate, then repoint `DATABASE_URL`.
- **Erasure caveat**: a GDPR hard-delete is only fully complete once PITR/backup windows roll
  past it — state the window when answering an erasure request (see `docs/data-retention.md`).

## Webhooks

- Clerk → `https://www.prepprofit.com/api/webhooks/clerk` (Svix). Signature-verified; a bad
  signature → 400. The `subscriptions` mirror is read-only observability and never gates access.

## Secret rotation

1. Generate the new secret at the provider (Clerk/Resend/Neon/Sentry/PostHog/Gemini).
2. Update the Vercel env var (Production) and redeploy.
3. Revoke the old secret at the provider. Rotate `CRON_SECRET` + the Clerk webhook secret on a
   schedule. Never commit secrets; `.env.local` is gitignored.

## Observability & incident response

- Errors flow through `logError` (`lib/observability.ts`) → structured `console.error` with an
  `eventId` **and** Sentry (5a), tagged with that id. Search Vercel logs by `eventId` and
  cross-link to the Sentry issue. No PII in logs/audit metadata.
- High-risk mutations append to `audit_log` (append-only). Use it to reconstruct what happened
  per org. Rate limiting (`rate_limits`) protects abuse-prone routes.

## Pre-launch checklist

- [ ] All Production env vars set; a fresh deploy is green.
- [ ] Migrations applied + verified (head 0019); RLS enabled + forced on every business table.
- [ ] Cron schedule live; manual hit returns 200.
- [ ] Clerk webhook endpoint live + secret set; a test event is accepted.
- [ ] Sentry receiving events (trigger a throw in a non-prod env to confirm).
- [ ] Resend domain verified; a test document email delivers.
- [ ] Billing: a test org can subscribe to Pro and unlock features; comped org has access.
- [ ] Data export downloads; a deletion request is recorded and visible to the operator query.
- [ ] CI green (lint, typecheck, tests, build); E2E smoke enabled if `RUN_E2E` secrets are set.
