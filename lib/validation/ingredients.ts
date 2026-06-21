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

/**
 * Operational-only ingredient input for KITCHEN (Sprint F4). Deliberately has NO
 * `priceCents`: kitchen never holds nor transmits a price. The server forces
 * `priceCents: 0` + `needsPricing: true` on create and preserves the stored price
 * on update, so a kitchen caller can edit name/dimension/supplier without ever
 * touching money. Zod strips unknown keys, so a forged `priceCents` is dropped here.
 */
export const kitchenIngredientSchema = z.object({
  name: z.string().trim().min(1).max(120),
  dimension: z.enum(DIMENSIONS),
  supplier: z
    .string()
    .trim()
    .max(120)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional(),
});

export type KitchenIngredientFormInput = z.infer<typeof kitchenIngredientSchema>;
