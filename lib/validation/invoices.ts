import { z } from 'zod';
import { dateStringSchema } from './transactions';
import { invoiceTotals } from '@/lib/calculations/invoice';

/** Postgres `integer` (int4) ceiling — the money columns are integer cents. */
const INT4_MAX = 2_147_483_647;

/**
 * Server-side validation for customers and invoices (CLAUDE.md: Zod on all user
 * input, on the server). The org id is never part of the payload — it is derived
 * from Clerk. Monetary values are integer cents; `taxRate` is a percentage.
 */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .default(null);

export const customerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  taxId: optionalText(60),
  address: optionalText(300),
  // Email is optional; when present it must look like an email.
  email: z
    .union([z.literal(''), z.string().trim().email().max(200)])
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .default(null),
});

export const invoiceItemSchema = z.object({
  description: z.string().trim().min(1).max(300),
  // Positive billed quantity (may be fractional), capped to keep totals in range.
  quantity: z.number().positive().max(1_000_000),
  // Net unit price in integer cents (0 allowed, e.g. a free line).
  unitPriceCents: z.number().int().min(0).max(1_000_000_000),
  // VAT rate as a percentage, 0..100.
  taxRate: z.number().min(0).max(100),
});

export const invoiceDraftSchema = z
  .object({
    // A draft may have no customer yet; one is required to issue (see the action).
    customerId: z.string().min(1).nullable().default(null),
    notes: optionalText(1000),
    // At least one line; the cap keeps a single invoice's compute bounded.
    items: z.array(invoiceItemSchema).min(1).max(200),
  })
  // The per-field caps each fit int4, but their PRODUCT/SUM (the stored subtotal,
  // tax and total cents) can overflow the integer columns. Compute the totals with
  // the SAME pure function used at issue and reject early with INVALID_INPUT,
  // instead of letting Postgres throw "integer out of range" at insert.
  .superRefine((draft, ctx) => {
    const totals = invoiceTotals(
      draft.items.map((it) => ({
        quantity: it.quantity,
        unitPriceCents: it.unitPriceCents,
        taxRate: it.taxRate,
      })),
    );
    if (
      totals.subtotalCents > INT4_MAX ||
      totals.taxCents > INT4_MAX ||
      totals.totalCents > INT4_MAX
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invoice total exceeds the maximum supported amount.',
        path: ['items'],
      });
    }
  });

export const issueInvoiceSchema = z.object({
  // Optional payment due date ('YYYY-MM-DD'); issue date is set server-side.
  dueDate: dateStringSchema.nullable().default(null),
});

export type CustomerInput = z.infer<typeof customerSchema>;
export type InvoiceItemInput = z.infer<typeof invoiceItemSchema>;
export type InvoiceDraftInput = z.infer<typeof invoiceDraftSchema>;
export type IssueInvoiceInput = z.infer<typeof issueInvoiceSchema>;
