import { z } from 'zod';
import { dateStringSchema } from '@/lib/validation/transactions';
import { DIMENSIONS } from '@/lib/validation/ingredients';
import { TRANSACTION_TYPES } from '@/lib/validation/transactions';
import { FILE_IMPORT_ENTITIES, IMPORT_FORMATS } from '@/lib/import/types';
import { MAX_SUGGESTIONS } from '@/lib/import/resolveIngredient';

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
