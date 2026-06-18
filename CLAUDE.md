# PrepProfit SaaS - Project Rules

## What this project is

PrepProfit is a multi-tenant B2B SaaS for restaurant, bakery, patisserie, and food-business
financial management. It replaces a spreadsheet kit with tested workflows for recipe costing,
inventory, financials, break-even, invoices, payroll, search, documents, imports, and reviewed
AI-assisted recipe extraction.

## Active stack

Do not change the stack without explicit approval.

- Next.js 15 App Router + React 19 + strict TypeScript
- PostgreSQL on Neon + Drizzle ORM
- Clerk auth with Organizations and org roles
- Tailwind CSS + shadcn/ui patterns + Recharts
- TanStack Table where grids need real table behavior
- next-intl for all UI copy and action error messages
- Zod for server-side validation
- Vitest + PGlite for calculation and database tests
- Vercel deployment

Planned additions must land only in their sprint:

- PDF rendering: Sprint 3.5A
- Resend email: Sprint 3.5C
- Clerk Billing/Stripe: Sprint 4
- Vision/AI recipe extraction: Sprint 4.7
- Sentry/PostHog/Playwright launch operations: Sprint 5

## Rule 1 - Multi-tenancy is non-negotiable

- Every business-data table has `organization_id`.
- Every query, including SELECT, INSERT, UPDATE, and DELETE, is explicitly scoped by `organization_id`.
- Never accept `organization_id` from the client. Derive it on the server with `getOrgId()`.
- Every business table is listed in `businessTables` so RLS is applied.
- Writes run inside `withOrg(...)` so RLS `USING` and `WITH CHECK` policies are active.
- Cross-tenant foreign links use composite `(organization_id, foreign_id)` FKs.
- A query without an org filter is a security bug.
- Documented exception: `rate_limits` is INFRA, not tenant data — it has no `organization_id`, is absent from `businessTables`, and gets no RLS. The limiter must run for the org-less cron route (before any `withOrg`), so tenancy is encoded — and sha256-hashed — inside the opaque `key`. This is the only table allowed to skip Rule 1.

## Audit log and rate limiting (Sprint 3.1)

- High-risk mutations (financial, invoice lifecycle, payroll, trash restore/purge, settings, exports, cron purge) append an `audit_log` event INSIDE the mutation's `withOrg` transaction (atomic, RLS-scoped) via `writeAuditEvent` (`lib/data/audit.ts`).
- `audit_log` is append-only at the DB layer: its RLS has SELECT + INSERT policies only (`lib/db/rls.ts`), so UPDATE/DELETE match zero rows. Never add an update/delete path for it.
- Audit `metadata` carries only non-sensitive descriptors (ids, counts, status). Never PII, raw notes, or document/image contents.
- The cron actor is `{ userId: null, role: 'system' }` — `actor_user_id` is nullable and `actor_role` accepts `'system'`.
- Abuse-prone routes/actions check the Postgres fixed-window limiter (`lib/rate-limit/`) BEFORE org work, keyed by `rateLimitKey(bucket, scope)` where authenticated scope is `"<orgId>:<userId>"` and cron scope is the auth header. Actions return `RATE_LIMITED`; route handlers return HTTP 429.

## Authorization

- Role comes from Clerk `auth().orgRole`.
- `org:admin` maps to `manager`; every other org role maps to `kitchen`.
- Sensitive pages render `NoAccess` for kitchen users.
- Sensitive Server Actions and Route Handlers return `FORBIDDEN` before any data access.
- Sensitive surfaces include financials, transactions, break-even, invoices, payroll, trash, settings, generated documents, billing, sensitive exports, and AI extraction usage controls.
- Dashboard is a documented product exception: financial widgets are manager-only; operational recipe/inventory widgets may be visible to kitchen only if PLANO.md keeps that decision.
- Plan/feature entitlement checks are server-side controls once Sprint 4 lands. UI hiding is never enough.

## Code rules

- Mutations use Server Actions unless a file download, webhook, upload, or cron route requires a Route Handler.
- All user input is validated with Zod on the server.
- Action failures return stable `ActionErrorCode` values mapped through next-intl.
- Unexpected errors go through `unexpected()` / `logError()`.
- Monetary values are stored as integer cents. Never store money as floats.
- Cost, margin, invoice, payroll, finance, inventory, and break-even calculations live in pure modules under `lib/calculations/` with tests for rounding and edge cases.
- Soft-delete active reads filter `deleted_at IS NULL`.
- Purge paths preserve history by nulling optional links before deleting referenced rows.
- No `any`, no `@ts-ignore`. Types derive from Drizzle schema, Zod schemas, or explicit domain types.
- UI strings always go through next-intl. No hardcoded user-visible strings.

## AI and import rules

- AI output is untrusted input. Validate with Zod, stage it server-side, and require human confirmation.
- AI/photo extraction must never create final recipes or ingredients directly.
- New ingredients from AI/import default to `priceCents = 0` and must be flagged as needing pricing.
- Store provider/cost/status metadata, not raw sensitive image contents, unless an explicit retention decision is approved.
- AI features require entitlement checks, usage limits, rate limits, audit logs, and stable error codes.

## Testing rules

- RLS tests cover reads and writes: SELECT isolation, INSERT `WITH CHECK`, UPDATE retag attempts, and DELETE reachability.
- RBAC tests prove manager-only actions return `FORBIDDEN` before data access.
- Money tests cover zero, negative, large values, rounding, NaN, and Infinity edges.
- CSV/XLSX/document/export paths must test formula-injection-safe text handling.
- AI extraction tests use mocked provider output and must cover hallucinated/ambiguous data, low confidence, usage limits, and cross-org job access.
- PGlite is the default local DB test layer. Real Postgres concurrency tests are required before launch for flows where PGlite cannot prove the property.

## Product modules

1. Recipes: ingredient cost, yield/loss, hidden costs, margin, folders, trash.
2. Financials: transactions, categories, dashboards, CSV export.
3. Inventory: stock movements, authoritative ledger, low-stock alerts.
4. Break-even: scenario simulator.
5. Payroll: employees, shifts, period summaries.
6. Invoices: customers, draft/issue/pay/void lifecycle, gap-free numbering.
7. Documents: print/PDF/XLSX/email outputs, planned in Sprint 3.5A/3.5B.
8. Imports: deterministic staged imports, planned in Sprint 4.5/4.6.
9. AI photo recipe extraction: reviewed recipe drafts from images, planned in Sprint 4.7.
10. Kitchen operations tasks: planned post-MVP unless prioritized by beta feedback.

## Subscription plans - target mapping for Sprint 4

- Starter: 1 user, up to 50 recipes, modules 1-3.
- Pro: 5 users, unlimited recipes, modules 1-4 plus invoices and limited AI extraction.
- Business: unlimited users and all modules, including payroll, advanced document/report workflows, and higher AI usage limits.

Until Sprint 4 lands, do not pretend plan gating exists. Build explicit server-side entitlement helpers during Sprint 4.

## Workflow

- Follow PLANO.md. It is the source of truth for sprint sequence.
- Do not start a sprint until previous blocking sprints are done or explicitly marked deferred.
- Before each sprint, resolve the decisions listed in that sprint and get approval.
- When a task is done, mark it `[x]` in PLANO.md only after code, tests, docs, and production notes are complete.
- Use small conventional commits.
- Before merge, run: `npm run lint && npm run typecheck && npm test && npm run build`.
- Never commit secrets. `.env.local` is gitignored.

## Commands

- Dev: `npm run dev`
- Build: `npm run build`
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`
- Tests: `npm test`
- Generate migration: `npm run db:generate`
- Apply migrations + RLS: `npm run db:migrate`
