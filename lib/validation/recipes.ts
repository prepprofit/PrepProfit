import { z } from 'zod';

/** Server-side validation for recipes and recipe lines. Org id is derived server-side. */

const cents = z.number().int().min(0).max(100_000_000);

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
    .max(2000)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional(),
});

export type RecipeFormInput = z.infer<typeof recipeSchema>;

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
