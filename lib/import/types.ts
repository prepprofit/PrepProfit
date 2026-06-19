/**
 * Shared types for the deterministic import foundation (Sprint 4.5).
 *
 * This module is intentionally DEPENDENCY-FREE (no imports from the Drizzle
 * schema or any runtime module) so it can be imported by `lib/db/schema.ts` for
 * the `import_jobs` jsonb column `$type` without creating an import cycle.
 *
 * Import is STAGED and deterministic (CLAUDE.md "AI and import rules"): a parse
 * step produces normalized, validated records server-side; a separate confirm
 * step applies them. The client never sends rows back — it holds only a job id.
 */

/** Entities importable in v1. Recipes are deferred to Sprint 4.6. */
export const IMPORT_ENTITIES = ['ingredients', 'transactions'] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

/** Supported file formats in v1. `.docx` tables are a Sprint 4.6 question. */
export const IMPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/**
 * Job lifecycle. `parsed` = staged, awaiting confirm; `committed` = applied
 * (immutable); `expired` = past `expires_at` before confirm; `failed` = parse or
 * apply error. Only `parsed` jobs can be confirmed (status flip under FOR UPDATE).
 */
export const IMPORT_STATUSES = ['parsed', 'committed', 'expired', 'failed'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/**
 * Stable, machine issue codes attached per source row. Stored in the job (never
 * English prose) so the UI localizes them via next-intl (`import.issues.<code>`).
 * A row carrying any HARD issue is excluded from the importable set; `DUPLICATE`
 * and `NEEDS_PRICING` are soft (skipped / flagged, see `IMPORT_SOFT_ISSUES`).
 */
export const IMPORT_ISSUE_CODES = [
  'MISSING_REQUIRED',
  'TOO_LONG',
  'INVALID_NUMBER',
  'NEGATIVE_AMOUNT',
  'INVALID_DATE',
  'INVALID_DIMENSION',
  'INVALID_TYPE',
  'UNKNOWN_CATEGORY',
  // Soft: an ingredient name that already exists in the org → row is skipped,
  // never an update (no silent price changes).
  'DUPLICATE',
  // Soft: a new ingredient imported without a price → created at 0 cents and
  // flagged as needing pricing (CLAUDE.md).
  'NEEDS_PRICING',
] as const;
export type ImportIssueCode = (typeof IMPORT_ISSUE_CODES)[number];

/** Issue codes that do NOT make a row un-importable (skip / flag, not reject). */
export const IMPORT_SOFT_ISSUES: readonly ImportIssueCode[] = [
  'DUPLICATE',
  'NEEDS_PRICING',
];

/** One problem found on one source row, localized client-side by `code`. */
export type ImportRowIssue = {
  /** 1-based source DATA row number (header is row 0, excluded). */
  row: number;
  /** The offending column header (machine name), or '' for a row-level issue. */
  column: string;
  code: ImportIssueCode;
};

/**
 * An insert-ready ingredient record (Sprint 4.5). Produced at preview, stored in
 * the job, re-validated and inserted at confirm. `priceCents` is integer cents;
 * a blank price imports as 0 with `needsPricing` true (CLAUDE.md).
 */
export type ImportIngredientRecord = {
  name: string;
  dimension: 'weight' | 'volume' | 'count';
  priceCents: number;
  supplier: string | null;
  needsPricing: boolean;
};

/**
 * An insert-ready transaction record. The category NAME is resolved to a concrete
 * `categoryId` (org-scoped) at preview; an unknown category is a hard issue, so a
 * stored record always has a resolved id. `recipeId` is null in v1 (recipe links
 * are restored in Sprint 4.6); `amountCents` is a positive integer-cents magnitude.
 */
export type ImportTransactionRecord = {
  type: 'income' | 'expense';
  categoryId: string;
  /** Resolved category display name, for the preview grid only. */
  categoryName: string;
  occurredOn: string;
  amountCents: number;
  recipeId: string | null;
  note: string | null;
};

/** The importable records stored in a job, narrowed by the job's `entity`. */
export type ImportRecord = ImportIngredientRecord | ImportTransactionRecord;
