/**
 * Dependency-free shared types for GENERIC provider-backed AI operations (Sprint 2
 * of the AI margin roadmap — Supplier Invoice Reader is the first).
 *
 * Like `lib/ai/types.ts` (photo extraction), this module is intentionally
 * IMPORT-FREE (no Drizzle schema, no SDK, no zod) so it can be imported by
 * `lib/db/schema.ts` for the new tables' column `$type`s without dragging the
 * Gemini SDK into the schema / migration tooling.
 *
 * These types back the GENERIC `ai_operation_attempts` ledger. The Sprint 4.7 photo
 * path keeps its own `ai_extraction_attempts` ledger + `lib/ai/types.ts` untouched
 * (D1: no risky migration of the working photo import).
 */

/**
 * Lifecycle of one AI operation attempt. `pending` is written BEFORE the provider
 * call (so even a crash leaves a trace); it flips to `succeeded` once the provider
 * returns usable output, or `failed` with an `error_code` on any provider/validation
 * error. Only `succeeded` (+ still-in-flight `pending`) rows count toward the monthly
 * quota for the feature.
 */
export const AI_OPERATION_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type AiOperationStatus = (typeof AI_OPERATION_STATUSES)[number];

/**
 * The metered AI features that write to the generic ledger. Only
 * `supplier_invoice_extraction` is live in Sprint 2; the rest are declared ahead of
 * their roadmap sprints so the enum (and its DB CHECK) never needs a schema change
 * to add the next feature — just start writing rows with the new value.
 */
export const AI_OPERATION_FEATURES = [
  'supplier_invoice_extraction',
  'profit_leak_explanation',
  'menu_engineering_explanation',
  'daily_close_summary',
  'prep_reorder_plan_summary',
  'kitchen_cfo_report',
] as const;
export type AiOperationFeature = (typeof AI_OPERATION_FEATURES)[number];

/**
 * Lifecycle of a staged supplier-invoice import (Sprint 2). `draft` = the model's
 * extraction the manager is reviewing; `applied` = approved lines were turned into
 * pending price observations (terminal); `void` = discarded without applying
 * (terminal). `staged` is reserved for a future two-step confirm and is unused in
 * the MVP (which applies straight from `draft`).
 */
export const SUPPLIER_INVOICE_IMPORT_STATUSES = [
  'draft',
  'staged',
  'applied',
  'void',
] as const;
export type SupplierInvoiceImportStatus =
  (typeof SUPPLIER_INVOICE_IMPORT_STATUSES)[number];

/**
 * Per-line review state. `needs_review` = the model read the line but it is missing
 * data required to derive a per-unit cost (quantity/pack/unit/price) or has no
 * matched ingredient yet — NEVER silently dropped. `ready` = complete + matched, so
 * apply will record a price observation. `ignored` = the manager excluded it.
 * `applied` = a price observation was recorded from it (terminal).
 */
export const SUPPLIER_INVOICE_LINE_STATUSES = [
  'ready',
  'needs_review',
  'ignored',
  'applied',
] as const;
export type SupplierInvoiceLineStatus =
  (typeof SUPPLIER_INVOICE_LINE_STATUSES)[number];

/**
 * Stable, machine issue codes for why an invoice line is `needs_review`. Localized
 * client-side (`suppliers.invoices.import.lineIssues.<code>`), never raw model prose.
 */
/**
 * The persisted AI explanation shape (Sprint 4, AI margin roadmap). Kept here — in the
 * dependency-free types module — so `lib/db/schema.ts` can `$type` the `profit_insights.
 * explanation` jsonb column WITHOUT importing the Gemini SDK / zod from
 * `lib/ai/profit-leak-explanation.ts`. That module's `ProfitLeakExplanation`
 * (`z.infer` of the runtime schema) is the untrusted-input validator and is structurally
 * identical to this — the runtime schema stays the source of truth for validation, this
 * is only the storage type.
 */
export type ProfitLeakExplanationData = {
  headline: string;
  explanation: string;
  actionLabel: string;
  riskLevel: 'low' | 'medium' | 'high';
};

export const SUPPLIER_INVOICE_LINE_ISSUE_CODES = [
  // No usable quantity (or it could not be parsed to a positive number).
  'MISSING_QUANTITY',
  // A pack size/unit is required to derive a per-unit cost but is missing.
  'MISSING_PACK',
  // No unit price and no line total to derive a price from.
  'MISSING_PRICE',
  // A unit token the parser did not recognise.
  'UNKNOWN_UNIT',
  // No matched ingredient selected yet (the manager must pick or create one).
  'NO_INGREDIENT_MATCH',
  // The line's pack unit dimension is incompatible with the matched ingredient.
  'PACK_UNIT_MISMATCH',
] as const;
export type SupplierInvoiceLineIssueCode =
  (typeof SUPPLIER_INVOICE_LINE_ISSUE_CODES)[number];
