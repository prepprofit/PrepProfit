import { z } from 'zod';
import { dateStringSchema } from '@/lib/validation/transactions';
import { DIMENSIONS } from '@/lib/validation/ingredients';
import { TRANSACTION_TYPES } from '@/lib/validation/transactions';
import { IMPORT_ENTITIES, IMPORT_FORMATS } from '@/lib/import/types';

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

/** Entity + format selection (template download, preview upload). */
export const importParamsSchema = z.object({
  entity: z.enum(IMPORT_ENTITIES),
  format: z.enum(IMPORT_FORMATS),
});

export type ImportParams = z.infer<typeof importParamsSchema>;

/** A staged job id (confirm payload — the ONLY thing the client sends back). */
export const confirmImportSchema = z.object({
  jobId: z.string().min(1).max(60),
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
