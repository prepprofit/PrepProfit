import { z } from 'zod';

/**
 * Server-side validation for ingredients (CLAUDE.md: Zod on all user input, on
 * the server). The org id is never part of the payload — it is derived from
 * Clerk on the server.
 */

export const DIMENSIONS = ['weight', 'volume', 'count'] as const;

export const ingredientSchema = z.object({
  name: z.string().trim().min(1).max(120),
  dimension: z.enum(DIMENSIONS),
  // Price per canonical purchase unit (per kg / litre / piece), integer cents.
  priceCents: z.number().int().min(0).max(100_000_000),
  supplier: z
    .string()
    .trim()
    .max(120)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional(),
});

export type IngredientFormInput = z.infer<typeof ingredientSchema>;
