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
  // Sprint 12b: staged daily-close sales. A `sales` job stages an
  // `ImportSalesPayload` (closes grouped by date) and confirms through the 12a
  // primitives (createSale → postSale), never writing income/movements directly.
  'sales',
] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

/** Entities whose staged payload is an `ImportRecipePayload` (share the confirm path). */
export const RECIPE_IMPORT_ENTITIES: readonly ImportEntity[] = ['recipes', 'recipe_photo'];

/**
 * Entities importable from a spreadsheet FILE — they have a downloadable template
 * and go through the generic preview→confirm upload. `recipe_photo` is NOT here: it
 * is staged only by the AI extract action, never the file/template routes.
 */
export const FILE_IMPORT_ENTITIES = ['ingredients', 'transactions', 'recipes', 'sales'] as const;
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
  // Sales import (Sprint 12b). HARD: a sale line's item name resolves to NO active
  // same-kind catalogue item (no exact match) — the import never creates catalogue
  // items, so the whole close is invalid until the name is fixed.
  'UNKNOWN_ITEM',
  // Sales import (Sprint 12b). HARD: a sale line's item name matches MORE THAN ONE
  // active same-kind item (duplicate display names) — v1 links only on a single
  // exact match, so the close is invalid until the catalogue is disambiguated.
  'AMBIGUOUS_ITEM',
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
  /**
   * Recipe instructions/notes. For an AI photo import this is the reviewed
   * preparation method, already normalized to the recipe-editor length bound. For a
   * spreadsheet import it is null (no method column). Never raw image bytes.
   */
  notes: string | null;
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

/* -------------------------------------------------------------------------- */
/* Sales import (Sprint 12b)                                                  */
/* -------------------------------------------------------------------------- */

/** The kind of catalogue item a sale line sells (mirrors `saleItems.itemKind`). */
export type ImportSaleItemKind = 'recipe' | 'menu' | 'ingredient';

/**
 * One normalized sale-item line within an imported close. The `item*Id` fields are
 * resolved exact-only against the org's ACTIVE catalogue at preview (D5): exactly
 * one of them is set when the name links, all null when it does not (the line then
 * carries an `UNKNOWN_ITEM` / `AMBIGUOUS_ITEM` issue and its close is invalid). All
 * money is integer cents; per-line tax is rounded then summed (tax.ts).
 */
export type ImportSaleLine = {
  /** 1-based spreadsheet line the row came from. */
  sourceLine: number;
  /** The sold item's kind, or null when the source cell was missing/unknown (a hard issue). */
  itemKind: ImportSaleItemKind | null;
  /** Raw item name from the file (display + frozen `item_name` source). */
  itemName: string;
  /** Lower/trim/collapsed key used for exact resolution. */
  normalizedItemName: string;
  itemRecipeId: string | null;
  itemMenuId: string | null;
  itemIngredientId: string | null;
  /** Integer units sold (≥ 1). */
  quantity: number;
  /** Canonical stock consumed per sold unit — set iff `itemKind === 'ingredient'`. */
  ingredientQtyCanonical: number | null;
  /** Exclusive net price per sold unit, integer cents. */
  unitNetCents: number;
  /** Per-line tax rate in basis points (0..10000). */
  taxRateBps: number;
  netCents: number;
  taxCents: number;
  grossCents: number;
};

/**
 * One imported daily close: all the lines sharing a `saleDate`, with rolled-up
 * totals and a disposition. `importable` closes are created+posted at confirm;
 * `skipped` closes already have a non-void sale for that date (D2); `invalid`
 * closes have ≥1 line carrying a hard issue. `stockMode` is the F5 decision at the
 * close date (financial-only before `stock_control_start_date`, else moves stock).
 */
export type ImportSaleClose = {
  saleDate: string;
  lines: ImportSaleLine[];
  netCents: number;
  taxCents: number;
  grossCents: number;
  status: 'importable' | 'skipped' | 'invalid';
  issues: ImportRowIssue[];
  stockMode: 'moves_stock' | 'financial_only';
};

/** The full stored payload for a `sales` job — closes grouped by date. */
export type ImportSalesPayload = {
  closes: ImportSaleClose[];
};

/**
 * The shape of a job's `normalized_rows`, narrowed by `entity`: a flat record
 * array for ingredients/transactions, the recipe payload for recipes, or the sales
 * payload (closes) for sales.
 */
export type ImportNormalizedRows =
  | ImportRecord[]
  | ImportRecipePayload
  | ImportSalesPayload;
