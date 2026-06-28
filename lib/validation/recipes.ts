import { z } from 'zod';

/** Server-side validation for recipes and recipe lines. Org id is derived server-side. */

const cents = z.number().int().min(0).max(100_000_000);

/**
 * Max length of a recipe's instructions/notes. The single source of truth shared by
 * the manual editor schemas (below) AND the photo-import boundary
 * (`lib/validation/import.ts`, `lib/ai/photo-draft.ts`), so an AI-extracted note is
 * normalized to exactly what the editor can later re-save (extraction itself caps at a
 * larger anti-balloon bound; this is the persistable recipe bound).
 */
export const RECIPE_NOTES_MAX_LENGTH = 2000;

export const recipeSchema = z.object({
  name: z.string().trim().min(1).max(160),
  // Folder this recipe is filed under; null/omitted = "No folder".
  folderId: z.string().min(1).nullable().optional(),
  yieldPortions: z.number().int().min(1).max(1_000_000),
  // Usable yield after loss, as a percentage.
  yieldPercentage: z.number().int().min(1).max(100),
  laborCostCents: cents,
  energyCostCents: cents,
  packagingCostCents: cents,
  sellingPriceCents: cents.nullable().optional(),
  notes: z
    .string()
    .trim()
    .max(RECIPE_NOTES_MAX_LENGTH)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional(),
});

export type RecipeFormInput = z.infer<typeof recipeSchema>;

/**
 * Operational-only recipe input for KITCHEN (Sprint F4). NO money fields
 * (`laborCostCents` / `energyCostCents` / `packagingCostCents` /
 * `sellingPriceCents`): kitchen edits only name/folder/yield/notes and never holds
 * nor transmits a cost or price. On create the server zeroes the money fields; on
 * update it preserves the stored ones. Zod strips unknown keys, so a forged money
 * field is dropped here.
 */
export const kitchenRecipeSchema = z.object({
  name: z.string().trim().min(1).max(160),
  folderId: z.string().min(1).nullable().optional(),
  yieldPortions: z.number().int().min(1).max(1_000_000),
  yieldPercentage: z.number().int().min(1).max(100),
  notes: z
    .string()
    .trim()
    .max(RECIPE_NOTES_MAX_LENGTH)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional(),
});

export type KitchenRecipeFormInput = z.infer<typeof kitchenRecipeSchema>;

/** A recipe line: a canonical quantity (g / ml / count) of an ingredient. */
export const recipeLineSchema = z.object({
  ingredientId: z.string().min(1),
  quantity: z.number().min(0).max(100_000_000),
  sortOrder: z.number().int().min(0).optional(),
});

export const recipeLineUpdateSchema = z.object({
  quantity: z.number().min(0).max(100_000_000),
  sortOrder: z.number().int().min(0).optional(),
});
