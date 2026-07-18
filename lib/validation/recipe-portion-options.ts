import { z } from 'zod';

/**
 * Zod contract for portion-option mutations (Recipes 2.0 Fase 5, §6.8).
 * Money is integer cents; targets are basis points 1..10000 — mirrors the DB
 * CHECKs so a bad payload dies before the transaction opens.
 */

/** Matches recipe_portion_options.quantity numeric(12,4). */
const PORTION_QUANTITY_MAX = 99_999_999.9999;
/** Sane ceiling for a selling price (integer cents). */
export const PORTION_PRICE_MAX_CENTS = 100_000_000;

const idSchema = z.string().min(1).max(64);

const portionOptionFields = {
  name: z.string().trim().min(1).max(120),
  quantity: z.number().finite().positive().max(PORTION_QUANTITY_MAX),
  unit: z.string().trim().min(1).max(40),
  sellingPriceCents: z
    .number()
    .int()
    .min(0)
    .max(PORTION_PRICE_MAX_CENTS)
    .nullable(),
  targetFoodCostBps: z.number().int().min(1).max(10000).nullable(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
};

export const createPortionOptionSchema = z.object({
  recipeId: idSchema,
  ...portionOptionFields,
});

export const updatePortionOptionSchema = z.object({
  optionId: idSchema,
  ...portionOptionFields,
});

export const portionOptionIdSchema = z.object({
  optionId: idSchema,
});

export type CreatePortionOptionInput = z.infer<typeof createPortionOptionSchema>;
export type UpdatePortionOptionInput = z.infer<typeof updatePortionOptionSchema>;
