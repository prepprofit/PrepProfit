import { z } from 'zod';

/**
 * Zod contracts for UoM equivalencies + prep actions (Recipes 2.0 Fase 4,
 * plan §6.6). Anchors are canonical amounts describing the SAME quantity of
 * the ingredient; domain limits match the numeric(12,4) columns and the
 * yield_bps CHECK (1..10000).
 */

/** Matches numeric(12,4): eight integer digits, four decimals. */
const ANCHOR_MAX = 99_999_999.9999;

const anchorSchema = z.number().finite().positive().max(ANCHOR_MAX).nullable();
const idSchema = z.string().min(1).max(64);

const anchorsShape = {
  weightGrams: anchorSchema,
  volumeMl: anchorSchema,
  eachCount: anchorSchema,
};

export const upsertEquivalencySchema = z
  .object({
    ingredientId: idSchema,
    ...anchorsShape,
    source: z.enum(['manual', 'standard']).default('manual'),
  })
  .refine(
    (v) =>
      [v.weightGrams, v.volumeMl, v.eachCount].filter((a) => a !== null).length >= 2,
    { message: 'at least two anchors required' },
  );

export const deleteEquivalencySchema = z.object({ ingredientId: idSchema });

export const PREP_ACTION_NAME_MAX = 80;

const prepActionFields = {
  name: z.string().trim().min(1).max(PREP_ACTION_NAME_MAX),
  /** Usable yield in basis points; 7854 = 78.54%. */
  yieldBps: z.number().int().min(1).max(10_000),
  ...anchorsShape,
  sortOrder: z.number().int().min(0).max(10_000).optional(),
};

export const createPrepActionSchema = z.object({
  ingredientId: idSchema,
  ...prepActionFields,
});

export const updatePrepActionSchema = z.object({
  prepActionId: idSchema,
  ...prepActionFields,
});

export const deletePrepActionSchema = z.object({ prepActionId: idSchema });
