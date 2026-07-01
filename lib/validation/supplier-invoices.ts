import { z } from 'zod';

/**
 * Server-side validation for the Supplier Invoice Reader review actions (Sprint 2,
 * AI margin roadmap). All manager input is validated here before any data access
 * (CLAUDE.md: all user input validated with Zod on the server).
 */

/** A nullable, positive physical amount (quantity / pack size). */
const positiveOrNull = z
  .number()
  .positive()
  .finite()
  .nullable();

/** A nullable, non-negative integer cents value. */
const centsOrNull = z.number().int().nonnegative().nullable();

/**
 * Patch for one review line. Every field is optional (partial edit); an absent field
 * leaves the stored value unchanged. `ignored` toggles the line in/out of apply.
 */
export const updateInvoiceLineSchema = z
  .object({
    itemNameRaw: z.string().trim().min(1).max(200).optional(),
    matchedIngredientId: z.string().trim().min(1).max(200).nullable().optional(),
    quantityValue: positiveOrNull.optional(),
    quantityUnit: z.string().trim().max(40).nullable().optional(),
    packSizeValue: positiveOrNull.optional(),
    packSizeUnit: z.string().trim().max(40).nullable().optional(),
    unitPriceCents: centsOrNull.optional(),
    lineTotalCents: centsOrNull.optional(),
    ignored: z.boolean().optional(),
  })
  .strict();

export type UpdateInvoiceLineInput = z.infer<typeof updateInvoiceLineSchema>;
