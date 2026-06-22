import { createHash } from 'node:crypto';
import { z } from 'zod';
import { dateStringSchema } from './transactions';
import { PO_INT4_MAX } from './purchase-orders';

/**
 * Server-side validation for goods receipts (Sprint 8b; CLAUDE.md: Zod on all user
 * input, on the server). The org id is never in the payload — it comes from Clerk.
 * Received quantities are CANONICAL (g / ml / count); the received unit cost is per
 * priced unit (kg / l / piece), integer cents. Per-field caps bound a single
 * receipt's compute; the totals/int4 overflow guard lives in the data layer where the
 * line dimensions are known.
 */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .default(null);

export const receiptItemSchema = z.object({
  // The ordered PO line this delivery fills (its ingredient/dimension is resolved
  // server-side from the line, never trusted from the client).
  purchaseOrderItemId: z.string().min(1),
  // Canonical amount received (g / ml / count); positive, capped to bound line math.
  receivedQuantity: z.number().positive().max(10_000_000),
  // Received cost per priced unit (per kg / litre / piece), integer cents (0 allowed).
  receivedUnitCostCents: z.number().int().min(0).max(100_000_000),
});

export const postReceiptSchema = z.object({
  purchaseOrderId: z.string().min(1),
  receivedDate: dateStringSchema,
  notes: optionalText(1000),
  // The client mints this once per receive form and resends it on retry (D6).
  clientMutationId: z.string().uuid(),
  // At least one line; the cap bounds a single receipt's compute.
  items: z.array(receiptItemSchema).min(1).max(200),
});

export const voidReceiptSchema = z.object({
  receiptId: z.string().min(1),
});

export const closePurchaseOrderSchema = z.object({
  purchaseOrderId: z.string().min(1),
  // Short-close requires an explicit reason (D4). Emptiness is checked in the action
  // so it maps to the dedicated PO_CLOSE_REASON_REQUIRED code, not INVALID_INPUT.
  reason: z.string().trim().max(1000).default(''),
});

export type ReceiptItemInput = z.infer<typeof receiptItemSchema>;
export type PostReceiptInput = z.infer<typeof postReceiptSchema>;

export { PO_INT4_MAX };

/**
 * Stable fingerprint of a receipt's meaningful payload (D6). Two submits with the
 * same `clientMutationId` are the "same" iff this hash matches; a different hash with
 * the same id is an IDEMPOTENCY_CONFLICT. Lines are sorted by PO-item id so client
 * ordering never changes the fingerprint; only fields that change stock/cost count.
 */
export function receiptPayloadHash(input: PostReceiptInput): string {
  const normalized = {
    purchaseOrderId: input.purchaseOrderId,
    receivedDate: input.receivedDate,
    items: [...input.items]
      .map((it) => ({
        purchaseOrderItemId: it.purchaseOrderItemId,
        receivedQuantity: it.receivedQuantity,
        receivedUnitCostCents: it.receivedUnitCostCents,
      }))
      .sort((a, b) =>
        a.purchaseOrderItemId < b.purchaseOrderItemId
          ? -1
          : a.purchaseOrderItemId > b.purchaseOrderItemId
            ? 1
            : 0,
      ),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
