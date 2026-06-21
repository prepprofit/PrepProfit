import { z } from 'zod';
import { ALLERGEN_SLUGS, PRESENCE_VALUES } from '@/lib/allergens/catalog';

/**
 * Server-side validation for allergen mutations (Sprint 9). Org id is always
 * derived server-side (RULE #1) — never part of these schemas. The enums are built
 * from the catalog (lib/allergens/catalog.ts), the single source of truth that the
 * DB CHECK constraints also repeat.
 */

export const allergenSlugSchema = z.enum(ALLERGEN_SLUGS);
export const presenceSchema = z.enum(PRESENCE_VALUES);

/** One allergen tag: which allergen, at what certainty of presence. */
export const allergenTagSchema = z.object({
  allergen: allergenSlugSchema,
  presence: presenceSchema,
});

/**
 * The full set of allergen tags for an ingredient (the atomic replace payload).
 * An empty array is valid — it means "reviewed, no allergens" (stamps the review,
 * clears the tags). A `.superRefine` rejects a duplicated allergen so the unique
 * (org, ingredient, allergen) constraint can never be violated at the DB.
 */
export const ingredientAllergensSchema = z
  .object({ allergens: z.array(allergenTagSchema).max(ALLERGEN_SLUGS.length) })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const tag of value.allergens) {
      if (seen.has(tag.allergen)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Duplicate allergen.',
          path: ['allergens'],
        });
      }
      seen.add(tag.allergen);
    }
  });

/** Add or escalate one recipe-level override. */
export const recipeOverrideSchema = allergenTagSchema;

/** Clear one recipe-level override (a manual addition/escalation). */
export const clearRecipeOverrideSchema = z.object({ allergen: allergenSlugSchema });

export type AllergenTagInput = z.infer<typeof allergenTagSchema>;
export type IngredientAllergensInput = z.infer<typeof ingredientAllergensSchema>;
export type RecipeOverrideInput = z.infer<typeof recipeOverrideSchema>;
