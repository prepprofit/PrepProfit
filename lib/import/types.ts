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

/**
 * Import entities. `recipes` (Sprint 4.6) and `recipe_photo` (Sprint 4.7) BOTH
 * stage an `ImportRecipePayload` and share the confirm path; they differ only in
 * origin (a spreadsheet vs an AI photo extraction) for audit/observability. All are
 * TS-only `import_jobs.entity` values — the drizzle text-enum emits no DB CHECK, so
 * adding one needs no migration.
 */
export const IMPORT_ENTITIES = [
  'ingredients',
  'transactions',
  'recipes',
  'recipe_photo',
] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

/** Entities whose staged payload is an `ImportRecipePayload` (share the confirm path). */
export const RECIPE_IMPORT_ENTITIES: readonly ImportEntity[] = ['recipes', 'recipe_photo'];

/**
 * Entities importable from a spreadsheet FILE — they have a downloadable template
 * and go through the generic preview→confirm upload. `recipe_photo` is NOT here: it
 * is staged only by the AI extract action, never the file/template routes.
 */
export const FILE_IMPORT_ENTITIES = ['ingredients', 'transactions', 'recipes'] as const;
export type FileImportEntity = (typeof FILE_IMPORT_ENTITIES)[number];

/** Physical dimension of a quantity — mirrors lib/units `Dimension`. */
export type ImportDimension = 'weight' | 'volume' | 'count';

/** Supported spreadsheet FILE formats (template + upload). `.docx` is backlog. */
export const IMPORT_FORMATS = ['csv', 'xlsx'] as const;
export type FileImportFormat = (typeof IMPORT_FORMATS)[number];

/**
 * Source format stored on a job. A spreadsheet job is `csv`/`xlsx`; an AI photo
 * extraction job (Sprint 4.7) is `photo`. TS-only on the column (drizzle text-enum
 * emits no DB CHECK) — adding `photo` needs no migration.
 */
export type ImportFormat = FileImportFormat | 'photo';

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
  // Recipe import (Sprint 4.6): an unrecognized unit token on a recipe line.
  'INVALID_UNIT',
  // Recipe import: a unit whose dimension conflicts with the existing ingredient's
  // dimension (decided in the data-layer planner), or two lines for the same
  // ingredient in one recipe using incompatible dimensions.
  'UNIT_MISMATCH',
  // Soft (recipe import): a recipe whose name already exists in the org → the whole
  // recipe is skipped (no silent update; v1 only CREATES recipes).
  'DUPLICATE_RECIPE',
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
  'DUPLICATE_RECIPE',
  'NEEDS_PRICING',
];

/** One problem found on one source row, localized client-side by `code`. */
export type ImportRowIssue = {
  /** 1-based spreadsheet LINE number (the header is line 1) — what the user sees. */
  line: number;
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

/* -------------------------------------------------------------------------- */
/* Recipe import (Sprint 4.6)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The resolution computed for ONE distinct ingredient name at preview, stored in
 * the job and used at confirm to VALIDATE the manager's choice (D8): a `link`
 * must target an id that was offered here (an exact match or one of the fuzzy
 * suggestions). `new` stages a fresh ingredient (priceCents 0, needs pricing).
 *
 * Resolution is NOT the final decision — the UI lets the manager pick among these
 * options (a fuzzy match defaults to "create new", never auto-linked).
 */
export type ImportIngredientResolution =
  | { kind: 'exact'; ingredientId: string; ingredientName: string }
  | {
      kind: 'fuzzy';
      suggestions: { ingredientId: string; name: string; score: number }[];
    }
  | { kind: 'new' };

/** One recipe line: an ingredient reference + a canonical quantity. */
export type ImportRecipeLine = {
  /** Raw ingredient name from the file (display + create-new label). */
  ingredientName: string;
  /** Normalized name — the key into the job's `resolutions` map. */
  normalizedName: string;
  /** Quantity in the line unit's canonical amount (g / ml / count). */
  quantityCanonical: number;
  /** Dimension inferred from the line's unit. */
  dimension: ImportDimension;
};

/** A recipe to create, with its lines (pre-resolution-applied, names not ids). */
export type ImportRecipeRecord = {
  name: string;
  yieldPortions: number;
  yieldPercentage: number;
  lines: ImportRecipeLine[];
};

/**
 * The full stored payload for a `recipes` job. Unlike ingredient/transaction jobs
 * (a flat record array), a recipe job also carries the per-distinct-ingredient
 * `resolutions` map so confirm can validate the client's chosen links against
 * exactly what the server offered (D8) — keyed by normalized ingredient name.
 */
export type ImportRecipePayload = {
  recipes: ImportRecipeRecord[];
  resolutions: Record<string, ImportIngredientResolution>;
};

/** The importable records stored in a job, narrowed by the job's `entity`. */
export type ImportRecord = ImportIngredientRecord | ImportTransactionRecord;

/**
 * The shape of a job's `normalized_rows`, narrowed by `entity`: a flat record
 * array for ingredients/transactions, or the recipe payload for recipes.
 */
export type ImportNormalizedRows = ImportRecord[] | ImportRecipePayload;
