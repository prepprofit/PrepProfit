import { z } from 'zod';

import { NUTRIENT_KEYS, type NutrientKey } from '@/lib/calculations/nutrition';

/**
 * Zod schemas for ingredient nutrition (Recipes 2.0 Fase 6, plan §6.7).
 * Custom values follow the per-100 g contract with non-negativity and
 * per-nutrient maximum bounds; `null` = unknown (never coerced to 0).
 */

/** Plausibility ceilings per 100 g — rejects fat-fingered custom input. */
const NUTRIENT_MAX: Record<NutrientKey, number> = {
  caloriesKcal: 900, // pure fat is ~884 kcal/100 g
  totalFatG: 100,
  saturatedFatG: 100,
  transFatG: 100,
  cholesterolMg: 3500, // dried egg yolk is ~2300 mg/100 g
  sodiumMg: 40000, // pure salt is ~38758 mg/100 g
  totalCarbohydrateG: 100,
  dietaryFiberG: 100,
  totalSugarsG: 100,
  addedSugarsG: 100,
  proteinG: 100,
  vitaminDMcg: 1000,
  calciumMg: 10000,
  ironMg: 1000,
  potassiumMg: 20000,
  caffeineMg: 10000,
};

function nutrientField(key: NutrientKey) {
  return z
    .number()
    .finite()
    .min(0)
    .max(NUTRIENT_MAX[key])
    .nullable();
}

const nutrientValuesShape = Object.fromEntries(
  NUTRIENT_KEYS.map((key) => [key, nutrientField(key)]),
) as Record<NutrientKey, ReturnType<typeof nutrientField>>;

/** All 17 per-100 g nutrient fields, each nullable (null = unknown). */
export const nutrientValuesSchema = z.object(nutrientValuesShape);

export type NutrientValuesInput = z.infer<typeof nutrientValuesSchema>;

export const searchUsdaSchema = z.object({
  query: z.string().trim().min(2).max(120),
  scope: z.enum(['common', 'branded']),
});

/**
 * Save = either a USDA selection (the server RE-FETCHES the food by fdcId and
 * snapshots the SERVER-side values — client-supplied nutrient numbers are never
 * trusted for a USDA profile) or a fully custom per-100 g profile.
 */
export const saveIngredientNutritionSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('usda'),
    ingredientId: z.string().min(1),
    fdcId: z.number().int().positive(),
  }),
  z.object({
    source: z.literal('custom'),
    ingredientId: z.string().min(1),
    values: nutrientValuesSchema,
  }),
]);

export const refreshIngredientNutritionSchema = z.object({
  ingredientId: z.string().min(1),
});
