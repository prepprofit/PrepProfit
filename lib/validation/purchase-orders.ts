import { z } from 'zod';
import { dateStringSchema } from './transactions';

/**
 * Server-side validation for purchase orders (Sprint 8a; CLAUDE.md: Zod on all
 * user input, on the server). The org id is never in the payload — it comes from
 * Clerk. Monetary values are integer cents; quantities are canonical (g / ml /
 * count). Per-field caps keep each value in a sane range; the TOTALS overflow guard
 * (the stored subtotal/total cents fitting int4) lives in the data layer, where the
 * ingredient dimensions needed to compute a line total are known.
 */

/** Postgres `integer` (int4) ceiling — PO numbers + money columns are integers. */
export const PO_INT4_MAX = 2_147_483_647;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .default(null);

export const purchaseOrderItemSchema = z.object({
  // The ingredient being ordered (its dimension is derived server-side, never trusted).
  ingredientId: z.string().min(1),
  // Canonical amount ordered (g / ml / count); positive, capped to bound line math.
  quantity: z.number().positive().max(10_000_000),
  // Negotiated cost per priced unit (per kg / litre / piece), integer cents (0 allowed).
  unitCostCents: z.number().int().min(0).max(100_000_000),
});

export const purchaseOrderDraftSchema = z.object({
  // A draft may have no supplier yet; one is required to SEND (enforced in the action).
  supplierId: z.string().min(1).nullable().default(null),
  // Optional manual PO-number edit (update path only; create auto-allocates). A
  // collision surfaces PO_NUMBER_TAKEN; the counter is advanced so it is never reused.
  number: z.number().int().positive().max(PO_INT4_MAX).optional(),
  expectedDate: dateStringSchema.nullable().default(null),
  notes: optionalText(1000),
  // A draft may be empty; the cap bounds a single PO's compute. Send requires ≥1.
  items: z.array(purchaseOrderItemSchema).max(200).default([]),
});

export type PurchaseOrderItemInput = z.infer<typeof purchaseOrderItemSchema>;
export type PurchaseOrderDraftInput = z.infer<typeof purchaseOrderDraftSchema>;
