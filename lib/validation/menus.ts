import { z } from 'zod';
import { DISH_INGREDIENT_UNITS, DISH_RECIPE_UNITS } from '@/lib/calculations/dish';

/**
 * Server-side validation for dishes (Menu redesign — Dish Builder; stored in
 * `menus`). CLAUDE.md: Zod on all user input, on the server; the org id is never
 * part of a payload. Money is integer cents (price per portion, EXCLUDING VAT), the
 * VAT rate is basis points. Manager-only at the action layer.
 *
 * A dish may be saved while still empty (a draft being built) — its cost is simply
 * incomplete until it has lines. A recipe or ingredient appears at most once per
 * dish; duplicates are rejected here, before any data access.
 */

/** Amounts are numeric(12,4): positive, below 1e8 (the column's 8 integer digits). */
export const MAX_DISH_AMOUNT = 99_999_999;
const amountSchema = z.number().positive().max(MAX_DISH_AMOUNT);

const recipeLineSchema = z.object({
  recipeId: z.string().trim().min(1),
  quantity: amountSchema,
  unit: z.enum(DISH_RECIPE_UNITS),
});

const ingredientLineSchema = z.object({
  ingredientId: z.string().trim().min(1),
  /** Amount in `unit` (the server converts to canonical and checks the dimension). */
  quantity: amountSchema,
  unit: z.enum(DISH_INGREDIENT_UNITS),
});

const optionalNotes = z
  .string()
  .trim()
  .max(1000)
  .transform((s) => (s === '' ? null : s))
  .nullable()
  .optional();

export const MAX_DISH_LINES = 100;

export const dishSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    folderId: z.string().trim().min(1).nullable(),
    portions: z.number().int().min(1).max(100_000),
    sellingPriceCents: z.number().int().min(0).max(2_147_483_647).nullable(),
    vatRateBps: z.number().int().min(0).max(10_000).nullable(),
    notes: optionalNotes,
    recipeLines: z.array(recipeLineSchema).max(MAX_DISH_LINES),
    ingredientLines: z.array(ingredientLineSchema).max(MAX_DISH_LINES),
  })
  .refine((v) => new Set(v.recipeLines.map((l) => l.recipeId)).size === v.recipeLines.length, {
    message: 'A recipe may appear only once in a dish.',
    path: ['recipeLines'],
  })
  .refine(
    (v) => new Set(v.ingredientLines.map((l) => l.ingredientId)).size === v.ingredientLines.length,
    { message: 'An ingredient may appear only once in a dish.', path: ['ingredientLines'] },
  );

export type DishFormInput = z.infer<typeof dishSchema>;

/** A folder name: trimmed, 1–80 chars. Uniqueness per org is enforced by the DB. */
export const menuFolderSchema = z.object({ name: z.string().trim().min(1).max(80) });

export const DISH_SORTS = ['modified', 'opened', 'name', 'created'] as const;
export type DishSort = (typeof DISH_SORTS)[number];

export const dishSearchSchema = z.object({ query: z.string().trim().min(1).max(100) });
