import { z } from 'zod';
import { dateStringSchema } from '@/lib/validation/transactions';
import { DIMENSIONS } from '@/lib/validation/ingredients';
import { TRANSACTION_TYPES } from '@/lib/validation/transactions';
import { FILE_IMPORT_ENTITIES, IMPORT_FORMATS, IMPORT_ISSUE_CODES } from '@/lib/import/types';
import { MAX_SUGGESTIONS } from '@/lib/import/resolveIngredient';
import { RECIPE_NOTES_MAX_LENGTH } from '@/lib/validation/recipes';
import { NUMERIC_12_2_MAX } from '@/lib/calculations/production';
import { MAX_TAX_RATE_BPS, saleTotals } from '@/lib/calculations/tax';

/**
 * Server-side validation contracts for deterministic imports (Sprint 4.5).
 *
 * Two layers:
 *  - Column CONTRACTS + caps used by the pure parser (`lib/import/parse.ts`).
 *  - Zod schemas for the NORMALIZED records stored in a job — re-validated at
 *    confirm as defense-in-depth (the stored JSON is never trusted blindly, even
 *    though we wrote it). The org id is always derived server-side, never here.
 */

/** Hard caps (anti-DoS): file bytes and data rows. */
export const MAX_IMPORT_BYTES = 1_000_000; // 1 MB
export const MAX_IMPORT_ROWS = 1_000;

/** How long a parsed job stays confirmable. */
export const IMPORT_JOB_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Entity + format selection (template download, preview upload — file flows only). */
export const importParamsSchema = z.object({
  entity: z.enum(FILE_IMPORT_ENTITIES),
  format: z.enum(IMPORT_FORMATS),
});

export type ImportParams = z.infer<typeof importParamsSchema>;

/**
 * One per-distinct-ingredient resolution choice sent at confirm for a RECIPE job
 * (Sprint 4.6). The client may only `link` to a server-offered id or `create` a
 * new ingredient; the server re-validates every choice against the job's stored
 * suggestions (D8), so a forged or cross-org id is rejected. `name` is the
 * normalized ingredient name (the key into the job's `resolutions` map).
 */
export const confirmResolutionSchema = z.discriminatedUnion('action', [
  z.object({
    name: z.string().min(1).max(120),
    action: z.literal('link'),
    ingredientId: z.string().min(1).max(60),
  }),
  z.object({
    name: z.string().min(1).max(120),
    action: z.literal('create'),
  }),
]);

export type ConfirmResolution = z.infer<typeof confirmResolutionSchema>;

/**
 * The confirm payload. For ingredient/transaction jobs the client sends ONLY the
 * job id (rows are never trusted from the client). For recipe jobs it also sends
 * the resolution choices, validated server-side against the stored suggestions.
 */
export const confirmImportSchema = z.object({
  jobId: z.string().min(1).max(60),
  resolutions: z.array(confirmResolutionSchema).max(MAX_IMPORT_ROWS).optional(),
});

/**
 * Column header contracts (exact, lowercase machine names). The transaction set
 * mirrors the CSV export (lib/finance/csv.ts) so an app-exported file re-imports.
 * `recipe` is a KNOWN column accepted for round-trip but NOT linked in v1 (recipe
 * resolution is Sprint 4.6). Any header outside a contract's set rejects the file.
 */
export const INGREDIENT_COLUMNS = ['name', 'dimension', 'price', 'supplier'] as const;
export const INGREDIENT_REQUIRED_COLUMNS = ['name', 'dimension'] as const;

export const TRANSACTION_COLUMNS = [
  'date',
  'type',
  'category',
  'recipe',
  'amount',
  'note',
] as const;
export const TRANSACTION_REQUIRED_COLUMNS = [
  'date',
  'type',
  'category',
  'amount',
] as const;

/** Field length limits (shared with the per-entity create schemas). */
export const IMPORT_LIMITS = {
  name: 120,
  supplier: 120,
  category: 120,
  note: 500,
} as const;

/**
 * Zod schema for a stored ingredient record (confirm-time re-validation). Mirrors
 * `ingredientSchema` but also carries the `needsPricing` flag computed at parse.
 */
export const importIngredientRecordSchema = z.object({
  name: z.string().trim().min(1).max(IMPORT_LIMITS.name),
  dimension: z.enum(DIMENSIONS),
  priceCents: z.number().int().min(0).max(100_000_000),
  supplier: z.string().trim().max(IMPORT_LIMITS.supplier).nullable(),
  needsPricing: z.boolean(),
});

/**
 * Zod schema for a stored transaction record. The category is already resolved to
 * an org-scoped id at preview; `recipeId` is null in v1. `amountCents` is a
 * positive integer-cents magnitude (direction comes from `type`).
 */
export const importTransactionRecordSchema = z.object({
  type: z.enum(TRANSACTION_TYPES),
  categoryId: z.string().min(1),
  categoryName: z.string().min(1).max(IMPORT_LIMITS.category),
  occurredOn: dateStringSchema,
  amountCents: z.number().int().positive().max(1_000_000_000),
  recipeId: z.string().min(1).nullable(),
  note: z.string().trim().max(IMPORT_LIMITS.note).nullable(),
});

export type ImportIngredientRecordInput = z.infer<typeof importIngredientRecordSchema>;
export type ImportTransactionRecordInput = z.infer<
  typeof importTransactionRecordSchema
>;

/* -------------------------------------------------------------------------- */
/* Recipe import (Sprint 4.6)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Recipe file contract — LONG format, one row per ingredient line, grouped by the
 * `recipe` name column (D1). `yield_*` are read from the FIRST row of each recipe
 * group (blank → defaults 1 / 100). `unit` is optional (blank ⇒ count).
 */
export const RECIPE_COLUMNS = [
  'recipe',
  'yield_portions',
  'yield_percentage',
  'ingredient',
  'quantity',
  'unit',
] as const;
export const RECIPE_REQUIRED_COLUMNS = ['recipe', 'ingredient', 'quantity'] as const;

/** Recipe-specific caps. `recipeName` mirrors `recipeSchema` (160). */
export const RECIPE_LIMITS = {
  recipeName: 160,
  ingredientName: 120,
  /** Max ingredient lines a single imported recipe may carry. */
  maxLines: 200,
  /** Max distinct recipes a single import may create. */
  maxRecipes: 500,
} as const;

const importQuantitySchema = z.number().positive().finite().max(100_000_000);

/** A stored recipe line (confirm-time re-validation). Names, not ids — resolution maps names→ids. */
export const importRecipeLineSchema = z.object({
  ingredientName: z.string().trim().min(1).max(RECIPE_LIMITS.ingredientName),
  normalizedName: z.string().min(1).max(RECIPE_LIMITS.ingredientName),
  quantityCanonical: importQuantitySchema,
  dimension: z.enum(DIMENSIONS),
});

/** A stored recipe record (confirm-time re-validation). */
export const importRecipeRecordSchema = z.object({
  name: z.string().trim().min(1).max(RECIPE_LIMITS.recipeName),
  yieldPortions: z.number().int().min(1).max(1_000_000),
  yieldPercentage: z.number().int().min(1).max(100),
  // Recipe instructions/notes, already normalized to the recipe-editor bound at the
  // import boundary. Optional + defaulted to null so jobs staged before this field
  // existed (and spreadsheet imports, which carry no method column) still confirm.
  notes: z
    .string()
    .trim()
    .max(RECIPE_NOTES_MAX_LENGTH)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional()
    .default(null),
  lines: z.array(importRecipeLineSchema).max(RECIPE_LIMITS.maxLines),
});

/** A stored per-name resolution (the server-offered options validated at confirm). */
export const importIngredientResolutionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('exact'),
    ingredientId: z.string().min(1).max(60),
    ingredientName: z.string().min(1).max(RECIPE_LIMITS.ingredientName),
  }),
  z.object({
    kind: z.literal('fuzzy'),
    suggestions: z
      .array(
        z.object({
          ingredientId: z.string().min(1).max(60),
          name: z.string().min(1).max(RECIPE_LIMITS.ingredientName),
          score: z.number().min(0).max(1),
        }),
      )
      .max(MAX_SUGGESTIONS),
  }),
  z.object({ kind: z.literal('new') }),
]);

/** The full stored payload for a recipe job (records + resolutions), re-validated at confirm. */
export const importRecipePayloadSchema = z.object({
  recipes: z.array(importRecipeRecordSchema).max(RECIPE_LIMITS.maxRecipes),
  resolutions: z.record(z.string(), importIngredientResolutionSchema),
});

export type ImportRecipeRecordInput = z.infer<typeof importRecipeRecordSchema>;
export type ImportRecipePayloadInput = z.infer<typeof importRecipePayloadSchema>;

/* -------------------------------------------------------------------------- */
/* Sales import (Sprint 12b)                                                   */
/* -------------------------------------------------------------------------- */

/** Postgres `integer` (int4) ceiling — the sale money columns are integer cents. */
const INT4_MAX = 2_147_483_647;

/**
 * Sales file contract — LONG format, one row per sale-item line, grouped into daily
 * closes by the `date` column (D1). `item_kind` is recipe | menu | ingredient.
 * `ingredient_qty_canonical` is REQUIRED for an ingredient line and BLANK otherwise.
 * `tax_rate_percent` is optional (blank → the org default rate, applied at preview).
 */
export const SALES_COLUMNS = [
  'date',
  'item_kind',
  'item_name',
  'quantity',
  'unit_net_price',
  'tax_rate_percent',
  'ingredient_qty_canonical',
] as const;
export const SALES_REQUIRED_COLUMNS = [
  'date',
  'item_kind',
  'item_name',
  'quantity',
  'unit_net_price',
] as const;

/** Sales-specific caps (mirror the 12a sale validation). */
export const SALES_LIMITS = {
  itemName: 120,
  /** Max lines a single imported close may carry (matches `linesSchema` in sales.ts). */
  maxLinesPerClose: 200,
} as const;

/** The kinds an imported sale line can sell. */
export const IMPORT_SALE_ITEM_KINDS = ['recipe', 'menu', 'ingredient'] as const;

/** A stored sale-item line (confirm-time re-validation; the stored JSON is never trusted). */
export const importSaleLineSchema = z.object({
  sourceLine: z.number().int().min(1),
  itemKind: z.enum(IMPORT_SALE_ITEM_KINDS).nullable(),
  itemName: z.string().min(1).max(SALES_LIMITS.itemName),
  normalizedItemName: z.string().min(1).max(SALES_LIMITS.itemName),
  itemRecipeId: z.string().min(1).nullable(),
  itemMenuId: z.string().min(1).nullable(),
  itemIngredientId: z.string().min(1).nullable(),
  quantity: z.number().int().min(1).max(100000),
  ingredientQtyCanonical: z.number().positive().max(NUMERIC_12_2_MAX).nullable(),
  unitNetCents: z.number().int().min(0).max(1_000_000_000),
  taxRateBps: z.number().int().min(0).max(MAX_TAX_RATE_BPS),
  netCents: z.number().int().min(0).max(INT4_MAX),
  taxCents: z.number().int().min(0).max(INT4_MAX),
  grossCents: z.number().int().min(0).max(INT4_MAX),
});

/**
 * A stored close. The `importable` arm carries the strict invariant the apply path
 * relies on: every line resolves to exactly ONE active same-kind id, and an
 * ingredient line carries its per-unit canonical quantity. `skipped`/`invalid`
 * closes are not applied, so their lines may be unresolved (all ids null).
 */
export const importSaleCloseSchema = z
  .object({
    saleDate: dateStringSchema,
    lines: z.array(importSaleLineSchema).min(1).max(SALES_LIMITS.maxLinesPerClose),
    netCents: z.number().int().min(0).max(INT4_MAX),
    taxCents: z.number().int().min(0).max(INT4_MAX),
    grossCents: z.number().int().min(0).max(INT4_MAX),
    status: z.enum(['importable', 'skipped', 'invalid']),
    issues: z
      .array(
        z.object({
          line: z.number().int(),
          column: z.string().max(120),
          code: z.enum(IMPORT_ISSUE_CODES),
        }),
      )
      .max(10_000),
    stockMode: z.enum(['moves_stock', 'financial_only']),
  })
  .superRefine((close, ctx) => {
    if (close.status !== 'importable') return;
    close.lines.forEach((line, i) => {
      // An importable line must have resolved to a concrete kind + single id.
      if (line.itemKind === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Importable line is missing its item kind.',
          path: ['lines', i, 'itemKind'],
        });
        return;
      }
      const refs = {
        recipe: line.itemRecipeId,
        menu: line.itemMenuId,
        ingredient: line.itemIngredientId,
      } as const;
      for (const [kind, value] of Object.entries(refs)) {
        const shouldBeSet = kind === line.itemKind;
        if (shouldBeSet && value === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Importable line is missing its ${kind} reference.`,
            path: ['lines', i],
          });
        }
        if (!shouldBeSet && value !== null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Importable line has an unexpected ${kind} reference.`,
            path: ['lines', i],
          });
        }
      }
      const hasQty = line.ingredientQtyCanonical != null;
      if (line.itemKind === 'ingredient' && !hasQty) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'An ingredient line needs a per-unit stock quantity.',
          path: ['lines', i, 'ingredientQtyCanonical'],
        });
      }
      if (line.itemKind !== 'ingredient' && hasQty) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Only ingredient lines carry a per-unit stock quantity.',
          path: ['lines', i, 'ingredientQtyCanonical'],
        });
      }
    });
    // Re-derive the close totals from the raw line fields and reject an overflow.
    const totals = saleTotals(
      close.lines.map((l) => ({ netCents: l.quantity * l.unitNetCents, bps: l.taxRateBps })),
    );
    if (
      totals.netCents > INT4_MAX ||
      totals.taxCents > INT4_MAX ||
      totals.grossCents > INT4_MAX
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Close total exceeds the maximum supported amount.',
        path: ['lines'],
      });
    }
  });

/** The full stored payload for a sales job (closes), re-validated at confirm. */
export const importSalesPayloadSchema = z.object({
  closes: z.array(importSaleCloseSchema).max(MAX_IMPORT_ROWS),
});

export type ImportSaleLineInput = z.infer<typeof importSaleLineSchema>;
export type ImportSalesPayloadInput = z.infer<typeof importSalesPayloadSchema>;
