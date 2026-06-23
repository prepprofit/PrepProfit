import { z } from 'zod';
import { dateStringSchema } from '@/lib/validation/transactions';

/**
 * Server-side validation for production plans (Sprint 11a). CLAUDE.md: Zod on all
 * user input, on the server. The org id is never part of the payload (derived from
 * Clerk). There is NO client field for cost, stock, explosion, status snapshot or
 * inventory movement — those derive on the server and can never be supplied.
 *
 * A saved production has 1..100 DISTINCT recipe lines (D2); a recipe may appear at
 * most once (multiples via `plannedQty`). Duplicate recipe ids are rejected here,
 * BEFORE any data access. `expectedUpdatedAt` (optimistic concurrency) is required on
 * every non-create mutation and must be a server-issued ISO timestamp.
 */

const productionItemSchema = z.object({
  recipeId: z.string().trim().min(1),
  // Integer portions of this recipe (1..100000) — D2.
  plannedQty: z.number().int().min(1).max(100000),
});

const referenceSchema = z
  .string()
  .trim()
  .max(200)
  .transform((s) => (s === '' ? null : s))
  .nullable()
  .optional();

const notesSchema = z
  .string()
  .trim()
  .max(1000)
  .transform((s) => (s === '' ? null : s))
  .nullable()
  .optional();

/** A server-issued ISO timestamp the client echoes back as the optimistic-lock token. */
export const expectedUpdatedAtSchema = z.string().datetime();

const itemsSchema = z.array(productionItemSchema).min(1).max(100);

const distinctRecipes = (v: { items: { recipeId: string }[] }): boolean =>
  new Set(v.items.map((i) => i.recipeId)).size === v.items.length;

const distinctMessage = {
  message: 'A recipe may appear only once in a production.',
  path: ['items'] as string[],
};

export const createProductionSchema = z
  .object({
    reference: referenceSchema,
    notes: notesSchema,
    // Optional while an incomplete draft; the `plan` transition requires it.
    plannedFor: dateStringSchema.nullable().optional(),
    items: itemsSchema,
  })
  .refine(distinctRecipes, distinctMessage);

export const updateProductionSchema = z
  .object({
    expectedUpdatedAt: expectedUpdatedAtSchema,
    reference: referenceSchema,
    notes: notesSchema,
    plannedFor: dateStringSchema.nullable().optional(),
    items: itemsSchema,
  })
  .refine(distinctRecipes, distinctMessage);

/** plan / reopen / delete carry only the optimistic-concurrency token. */
export const productionStateSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
});

export type CreateProductionInput = z.infer<typeof createProductionSchema>;
export type UpdateProductionInput = z.infer<typeof updateProductionSchema>;
export type ProductionStateInput = z.infer<typeof productionStateSchema>;
