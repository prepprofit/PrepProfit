import { z } from 'zod';

/** Server-side validation for inventory. Org id is derived server-side. */

export const movementSchema = z.object({
  ingredientId: z.string().min(1),
  // Signed canonical change; must be non-zero.
  deltaCanonical: z
    .number()
    .min(-100_000_000)
    .max(100_000_000)
    .refine((v) => v !== 0, { message: 'Quantity must not be zero.' }),
  note: z
    .string()
    .trim()
    .max(200)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional(),
});

export const thresholdSchema = z.object({
  lowStockThreshold: z.number().min(0).max(100_000_000).nullable(),
});
