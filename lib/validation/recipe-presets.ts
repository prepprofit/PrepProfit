import { z } from 'zod';

/**
 * Server-side validation for kitchen presets (Recipe-editor parity). Org id is
 * derived server-side; the client never sends `organization_id` or any cost field.
 *
 * Formula-injection note: the stored name is the user's LITERAL text — it is never
 * mutated here to neutralize spreadsheet formulas. Any spreadsheet renderer that
 * later emits a preset name must use the existing `textCell` / `neutralizeFormula`
 * helpers (lib/finance/csv.ts, lib/documents/xlsx.ts).
 */

/** Max presets per recipe — far above any real kitchen's needs, a sane abuse cap. */
export const MAX_RECIPE_PRESETS = 30;

/**
 * Target finished weight in canonical grams: finite, strictly positive, within the
 * `numeric(10,2)` domain (≤ 99_999_999.99). The editor converts the display-unit
 * input to canonical grams before submit.
 */
const targetWeightGrams = z.number().finite().positive().max(99_999_999.99);

export const recipePresetSchema = z.object({
  name: z.string().trim().min(1).max(80),
  targetWeightGrams,
});

export type RecipePresetInput = z.infer<typeof recipePresetSchema>;

/**
 * Reorder payload: the recipe's preset ids in their new order. The data layer does
 * the authoritative exact-set check against the locked current rows; here we only
 * bound the array and reject DUPLICATE ids (a duplicate is INVALID_INPUT, never
 * silently accepted). The ids are opaque — no org or recipe data is in the payload.
 */
export const reorderRecipePresetsSchema = z
  .object({
    orderedPresetIds: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(MAX_RECIPE_PRESETS),
  })
  .refine(
    (v) => new Set(v.orderedPresetIds).size === v.orderedPresetIds.length,
    { message: 'Duplicate preset ids are not allowed.', path: ['orderedPresetIds'] },
  );

export type ReorderRecipePresetsInput = z.infer<typeof reorderRecipePresetsSchema>;
