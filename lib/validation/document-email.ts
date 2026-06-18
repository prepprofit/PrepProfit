import { z } from 'zod';
import { isValidPeriodKey, type PeriodView } from '@/lib/finance/period';

/**
 * Server-side validation for the document-email action (Sprint 3.5C). The client
 * sends ONLY what identifies the document plus the recipient — `documentType`,
 * the entity id (or P&L period), and `recipient`. It NEVER sends PDF bytes, an
 * `organization_id`, or a document URL: the server derives the org from Clerk and
 * regenerates the document itself. A discriminated union keeps each type's shape
 * exact, and the recipient is a real, length-capped email address.
 */

/** Trimmed, length-capped recipient email. */
const recipient = z.string().trim().min(3).max(254).email();

export const documentEmailSchema = z.discriminatedUnion('documentType', [
  z.object({
    documentType: z.literal('invoice'),
    invoiceId: z.string().uuid(),
    recipient,
  }),
  z.object({
    documentType: z.literal('recipeCard'),
    recipeId: z.string().uuid(),
    recipient,
  }),
  z
    .object({
      documentType: z.literal('pl'),
      view: z.enum(['month', 'year']).default('month'),
      period: z.string().optional(),
      recipient,
    })
    .refine(
      (v) => v.period === undefined || isValidPeriodKey(v.view as PeriodView, v.period),
      { path: ['period'], message: 'period does not match the selected view' },
    ),
]);

export type DocumentEmailInput = z.infer<typeof documentEmailSchema>;
