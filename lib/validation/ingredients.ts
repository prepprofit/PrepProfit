import { z } from 'zod';
import { ingredientSupplierSchema } from '@/lib/validation/suppliers';

/**
 * Server-side validation for ingredients (CLAUDE.md: Zod on all user input, on
 * the server). The org id is never part of the payload — it is derived from
 * Clerk on the server.
 *
 * Sprint 7: `supplier` is NO LONGER part of the ingredient payload. A supplier is
 * set ONLY through the supplier-link flow (`setIngredientSupplierAction` →
 * `setDefaultSupplier`), which writes the legacy `ingredients.supplier` mirror.
 * Zod strips unknown keys, so a forged `supplier` field is dropped here — closing
 * the old free-text path at the server contract (UI hiding is not enough).
 */

export const DIMENSIONS = ['weight', 'volume', 'count'] as const;

export const ingredientSchema = z.object({
  name: z.string().trim().min(1).max(120),
  dimension: z.enum(DIMENSIONS),
  // Price per canonical purchase unit (per kg / litre / piece), integer cents.
  priceCents: z.number().int().min(0).max(100_000_000),
});

export type IngredientFormInput = z.infer<typeof ingredientSchema>;

/**
 * Operational-only ingredient input for KITCHEN (Sprint F4). Deliberately has NO
 * `priceCents`: kitchen never holds nor transmits a price. The server forces
 * `priceCents: 0` + `needsPricing: true` on create and preserves the stored price
 * on update, so a kitchen caller can edit name/dimension without ever touching
 * money. Zod strips unknown keys, so a forged `priceCents` (or `supplier`, Sprint
 * 7) is dropped here.
 */
export const kitchenIngredientSchema = z.object({
  name: z.string().trim().min(1).max(120),
  dimension: z.enum(DIMENSIONS),
});

export type KitchenIngredientFormInput = z.infer<typeof kitchenIngredientSchema>;

/**
 * The unified ingredient editor (name + dimension + supplier + pricing, ONE Save).
 * MANAGER-ONLY at the action layer. `supplier` and `clearSupplier` are mutually
 * exclusive with each other; both are optional — omitting both leaves the
 * ingredient's supplier link untouched. `priceCents` is a DIRECT manual price and
 * is only honoured when no supplier is being set/cleared in this same save (once a
 * supplier is linked, its own pack price governs cost through the existing
 * pending/accept flow — never overwritten here); omitted = keep the stored price.
 */
export const ingredientEditorSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    dimension: z.enum(DIMENSIONS),
    priceCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
    supplier: ingredientSupplierSchema.nullable().optional(),
    clearSupplier: z.boolean().optional(),
  })
  .refine((v) => !(v.supplier && v.clearSupplier), {
    message: 'supplier and clearSupplier are mutually exclusive',
  });

export type IngredientEditorInput = z.infer<typeof ingredientEditorSchema>;
