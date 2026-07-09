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

/**
 * Usable finished batch weight, in canonical grams. OPERATIONAL physical data (not
 * money), so it appears in BOTH the manager and kitchen schemas. NULL = not set; the
 * editor converts a blank input to `null` before submit. `numeric(10,2)` domain →
 * max 99_999_999.99; must be finite + strictly positive when present.
 */
const yieldWeightGrams = z
  .number()
  .finite()
  .positive()
  .max(99_999_999.99)
  .nullable()
  .optional();

export const recipeSchema = z.object({
  name: z.string().trim().min(1).max(160),
  // Folder this recipe is filed under; null/omitted = "No folder".
  folderId: z.string().min(1).nullable().optional(),
  yieldPortions: z.number().int().min(1).max(1_000_000),
  // Usable yield after loss, as a percentage.
  yieldPercentage: z.number().int().min(1).max(100),
  yieldWeightGrams,
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
  // Operational physical data — kitchen edits the batch weight (no money exposed).
  yieldWeightGrams,
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

/** Upper bound on lines reordered in one call — far above any real recipe. */
export const MAX_REORDER_LINES = 1000;

/**
 * Reorder payload: the recipe's line ids in their new order. The data layer does
 * the authoritative exact-set check against the locked current lines; here we only
 * bound the array and reject DUPLICATE ids (a duplicate is INVALID_INPUT, never
 * silently accepted). The ids are opaque — no org or recipe data is in the payload.
 */
export const reorderRecipeIngredientsSchema = z
  .object({
    orderedLineIds: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(MAX_REORDER_LINES),
  })
  .refine(
    (v) => new Set(v.orderedLineIds).size === v.orderedLineIds.length,
    { message: 'Duplicate line ids are not allowed.', path: ['orderedLineIds'] },
  );

export type ReorderRecipeIngredientsInput = z.infer<
  typeof reorderRecipeIngredientsSchema
>;

/**
 * A sub-recipe component line: grams of the component recipe's finished output
 * (v1 unit is grams only). Quantity is strictly positive — a 0 g component line
 * is meaningless (unlike ingredient lines, which allow 0 as a placeholder).
 */
export const recipeComponentSchema = z.object({
  componentRecipeId: z.string().trim().min(1),
  quantityGrams: z
    .number()
    .refine(Number.isFinite, { message: 'Quantity must be finite.' })
    .gt(0)
    .max(100_000_000),
  sortOrder: z.number().int().min(0).optional(),
});

export type RecipeComponentInput = z.infer<typeof recipeComponentSchema>;

export const recipeComponentUpdateSchema = z.object({
  quantityGrams: z
    .number()
    .refine(Number.isFinite, { message: 'Quantity must be finite.' })
    .gt(0)
    .max(100_000_000),
  sortOrder: z.number().int().min(0).optional(),
});

export type RecipeComponentUpdateInput = z.infer<typeof recipeComponentUpdateSchema>;

/** Reorder payload for component lines — same contract as ingredient reorder. */
export const reorderRecipeComponentsSchema = z
  .object({
    orderedLineIds: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(MAX_REORDER_LINES),
  })
  .refine(
    (v) => new Set(v.orderedLineIds).size === v.orderedLineIds.length,
    { message: 'Duplicate line ids are not allowed.', path: ['orderedLineIds'] },
  );

export type ReorderRecipeComponentsInput = z.infer<
  typeof reorderRecipeComponentsSchema
>;
