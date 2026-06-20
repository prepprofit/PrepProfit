# Data retention & GDPR runbook (Sprint 5e)

PrepProfit is a multi-tenant B2B SaaS. All customer data is org-scoped (RULE #1) and
isolated at the database layer (RLS). This document records what we keep, for how long,
and how we handle GDPR data-subject requests (access/portability and erasure).

## Data categories & retention

| Category | Where | Retention | Notes |
|---|---|---|---|
| Recipes, ingredients, folders | `recipes`, `ingredients`, `recipe_folders`, `recipe_ingredients` | Life of the org | Soft-deleted rows (`deleted_at`) are purged after 30 days by the cron route. |
| Inventory ledger | `inventory_movements` | Life of the org | Authoritative stock history. |
| Financials | `transactions`, `transaction_categories` | Life of the org | Money as integer cents. |
| Invoices & customers | `invoices`, `invoice_items`, `invoice_counters`, `customers` | Life of the org | Kept for legal/accounting; gap-free numbering must be preserved even on purge. |
| Payroll PII | `employees`, `shifts` | Life of the org | Contains personal data (names, pay). Export metadata is counts only; documents are manager-only. |
| Imports | `import_jobs` | Auto-expire 24h after `parsed`; committed jobs immutable | `normalized_rows` holds staged file contents until expiry/commit. |
| AI extraction metadata | `ai_extraction_attempts` | Life of the org | Provider/model/token/quality flags only. Uploaded **images are ephemeral** — processed in-memory and never stored. |
| Audit log | `audit_log` | Life of the org | Append-only (SELECT+INSERT RLS). PII-free metadata (ids, counts, status). |
| Billing mirror | `subscriptions` | Life of the org | Read-only display; entitlements read Clerk live. |
| Trash | rows with `deleted_at` set | 30 days, then cron purge | Purge nulls optional links before deleting referenced rows. |
| Rate limiter | `rate_limits` | Short-lived (fixed window) | Infra, not tenant data; keys are sha256-hashed. No `organization_id`. |
| Identity & membership | Clerk | Per Clerk | Users, org membership, roles live in Clerk, not our DB. |

## Access / portability requests (GDPR Art. 15 & 20)

Self-service, manager-only:

- **UI**: `/settings` → "Data & privacy" → "Download data export".
- **API**: `GET /api/account/export` (manager-only, rate-limited `accountExport` 3/min,
  audited `account.export`). Returns a JSON bundle of every business table the org owns
  (`lib/data/account-export.ts`), scoped to the active org via `withOrg` + explicit
  `organization_id` filter. Read-only; deletes nothing.

Note: identity data (email, name) lives in Clerk — for a full subject export, combine the
app bundle with the Clerk user export.

## Erasure requests (GDPR Art. 17)

Org self-deletion is **disabled** in Clerk (`organization_settings.admin_delete_enabled =
false`, Sprint 4e), so erasure is operator-fulfilled to prevent accidental/abusive
self-deletion and preserve invoice/accounting integrity until checked.

1. **Request** — a manager submits `/settings` → "Data & privacy" → "Request account
   deletion" (optional reason). This sets `organization_settings.deletion_requested_at/by/
   reason` and writes a PII-free `account.deletionRequest` audit event. It deletes nothing.
2. **Triage** — an operator finds pending requests:
   `SELECT organization_id, deletion_requested_at, deletion_requested_by, deletion_reason
   FROM organization_settings WHERE deletion_requested_at IS NOT NULL;`
3. **Fulfil** — within **30 days**: confirm no outstanding legal/accounting hold (invoices),
   then delete the org in Clerk (operator-enabled) and purge its DB rows org-by-org. Record
   completion.
4. **Cancel** — the manager (or operator) can clear the request before fulfilment
   (`account.deletionCancel` audit event).

## Operational notes

- Backups: Neon PITR retains point-in-time history; a hard erasure is only complete once
  backup retention windows roll past the deletion. Document the window when responding.
- Never store PII in `audit_log.metadata`. Never log secrets, image contents, or raw notes.
