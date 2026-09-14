import { z } from 'zod';
import {
  DISH_INGREDIENT_UNITS,
  DISH_OUTPUT_UNITS,
  DISH_RECIPE_UNITS,
  outputKind,
  PRICE_BASES,
  priceBasisFor,
  roundHours,
} from '@/lib/calculations/dish';

/**
 * Server-side validation for Menu products (one batch; stored in `menus`).
 * CLAUDE.md: Zod on all user input, on the server; the org id is never part of a
 * payload. Money is integer cents (selling price EXCLUDING VAT, per `priceBasis`);
 * VAT is basis points. Manager-only at the action layer.
 *
 * A product may be saved while still empty (a draft). Labour is either absent (null
 * → recipe labour applies) or BOTH hours and hourly cost — partial labour is
 * rejected. The price basis must match the output kind (weight → per kg, count →
 * per unit); a finished weight only belongs to a count batch.
 */

/** Amounts are numeric(12,4): positive, below 1e8 (the column's 8 integer digits). */
export const MAX_DISH_AMOUNT = 99_999_999;
const amountSchema = z.number().positive().max(MAX_DISH_AMOUNT);

/** Hours are stored with 2 decimals; round once here so what's saved is what was costed. */
const hoursSchema = z
  .number()
  .min(0)
  .max(100_000)
  .transform(roundHours);
const hourlyCentsSchema = z.number().int().min(0).max(10_000_000);

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

const descriptionSchema = z.string().trim().min(1).max(120);

const extraSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('work'),
    description: descriptionSchema,
    hours: hoursSchema,
    hourlyCents: hourlyCentsSchema,
  }),
  z.object({
    kind: z.literal('expense'),
    description: descriptionSchema,
    amountCents: z.number().int().min(0).max(100_000_000),
  }),
]);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional();

export const MAX_DISH_LINES = 100;
export const MAX_DISH_EXTRAS = 50;

export const dishSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    folderId: z.string().trim().min(1).nullable(),
    output: z.object({
      /** In `unit` (kg is converted to grams server-side). */
      quantity: amountSchema,
      unit: z.enum(DISH_OUTPUT_UNITS),
      sizeDescription: optionalText(80),
      finishedWeightGrams: z
        .number()
        .positive()
        .max(MAX_DISH_AMOUNT)
        .transform((g) => Math.round(g * 100) / 100)
        .nullable(),
    }),
    sellingPriceCents: z.number().int().min(0).max(2_147_483_647).nullable(),
    priceBasis: z.enum(PRICE_BASES),
    vatRateBps: z.number().int().min(0).max(10_000).nullable(),
    labour: z.object({ hours: hoursSchema, hourlyCents: hourlyCentsSchema }).nullable(),
    extras: z.array(extraSchema).max(MAX_DISH_EXTRAS),
    notes: optionalText(1000),
    recipeLines: z.array(recipeLineSchema).max(MAX_DISH_LINES),
    ingredientLines: z.array(ingredientLineSchema).max(MAX_DISH_LINES),
  })
  .superRefine((v, ctx) => {
    if (v.priceBasis !== priceBasisFor(v.output.unit)) {
      ctx.addIssue({ code: 'custom', message: 'Price basis must match the output unit.', path: ['priceBasis'] });
    }
    if (v.output.finishedWeightGrams !== null && outputKind(v.output.unit) === 'weight') {
      ctx.addIssue({
        code: 'custom',
        message: 'A finished weight only applies to a count batch.',
        path: ['output', 'finishedWeightGrams'],
      });
    }
    if (new Set(v.recipeLines.map((l) => l.recipeId)).size !== v.recipeLines.length) {
      ctx.addIssue({ code: 'custom', message: 'A recipe may appear only once.', path: ['recipeLines'] });
    }
    if (new Set(v.ingredientLines.map((l) => l.ingredientId)).size !== v.ingredientLines.length) {
      ctx.addIssue({ code: 'custom', message: 'An ingredient may appear only once.', path: ['ingredientLines'] });
    }
  });

export type DishFormInput = z.infer<typeof dishSchema>;
/** The same shape BEFORE Zod transforms (what a client/test sends). */
export type DishFormPayload = z.input<typeof dishSchema>;

/** "Make a copy": the new product's name (the UI proposes "<name> (copy)"). */
export const dishCopySchema = z.object({ name: z.string().trim().min(1).max(200) });

/** A folder name: trimmed, 1–80 chars. Uniqueness per org is enforced by the DB. */
export const menuFolderSchema = z.object({ name: z.string().trim().min(1).max(80) });

export const DISH_SORTS = ['modified', 'opened', 'name', 'created'] as const;
export type DishSort = (typeof DISH_SORTS)[number];

export const dishSearchSchema = z.object({ query: z.string().trim().min(1).max(100) });

type RecipeLineShape = { recipeId: string; quantity: number; unit: (typeof DISH_RECIPE_UNITS)[number] };

/**
 * Recipe components are ENTERED in grams. A line in any other unit (recipe portions,
 * kilograms from older saves) is only accepted when it is exactly as already stored
 * — so a legacy line can wait for correction without being reinterpreted, but no
 * new or edited line can use portions. Pure; the action supplies the stored lines.
 */
export function recipeLinesUseGrams(next: readonly RecipeLineShape[], stored: readonly RecipeLineShape[]): boolean {
  return next.every(
    (line) =>
      line.unit === 'g' ||
      stored.some(
        (prev) =>
          prev.recipeId === line.recipeId &&
          prev.unit === line.unit &&
          Math.abs(prev.quantity - line.quantity) < 1e-6,
      ),
  );
}
