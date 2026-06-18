import { z } from 'zod';

/**
 * Server-side validation for transactions and custom categories (CLAUDE.md: Zod
 * on all user input, on the server). The org id is never part of the payload —
 * it is derived from Clerk. Monetary value is POSITIVE integer cents (direction
 * comes from `type`); the client converts the entered amount to cents.
 */

export const TRANSACTION_TYPES = ['income', 'expense'] as const;
export const CATEGORY_KINDS = ['income', 'expense'] as const;

/**
 * A bare calendar date 'YYYY-MM-DD' (no time, no timezone). The regex pins the
 * shape; the refine rejects shapes that are well-formed but impossible
 * (2026-13-01, 2026-02-30, day 00) by round-tripping through a UTC Date.
 */
export const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((s) => {
    const parts = s.split('-');
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return (
      dt.getUTCFullYear() === y &&
      dt.getUTCMonth() === m - 1 &&
      dt.getUTCDate() === d
    );
  }, 'Not a real calendar date');

/**
 * Query filters for the CSV export route — the same dimensions as the list view.
 * Empty params are dropped to `undefined` by the caller, so only real values are
 * validated; impossible dates are rejected by {@link dateStringSchema}.
 */
export const transactionExportFilterSchema = z.object({
  from: dateStringSchema.optional(),
  to: dateStringSchema.optional(),
  type: z.enum(TRANSACTION_TYPES).optional(),
  category: z.string().min(1).max(120).optional(),
});

export type TransactionExportFilterInput = z.infer<
  typeof transactionExportFilterSchema
>;

export const transactionSchema = z.object({
  type: z.enum(TRANSACTION_TYPES),
  categoryId: z.string().min(1),
  // Optional recipe link (income → top products); null is valid.
  recipeId: z.string().min(1).nullable().default(null),
  occurredOn: dateStringSchema,
  // Positive magnitude in integer cents (≤ 10,000,000.00).
  amountCents: z.number().int().positive().max(1_000_000_000),
  note: z
    .string()
    .trim()
    .max(500)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .default(null),
});

export const categoryNameSchema = z.string().trim().min(1).max(60);

export const customCategoryCreateSchema = z.object({
  name: categoryNameSchema,
  kind: z.enum(CATEGORY_KINDS),
});

export const customCategoryRenameSchema = z.object({
  name: categoryNameSchema,
});

export type TransactionFormInput = z.infer<typeof transactionSchema>;
export type CustomCategoryCreateInput = z.infer<typeof customCategoryCreateSchema>;
export type CustomCategoryRenameInput = z.infer<typeof customCategoryRenameSchema>;
