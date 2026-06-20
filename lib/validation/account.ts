import { z } from 'zod';

/**
 * GDPR account-deletion request input (Sprint 5e). The only user-supplied field is
 * an optional free-text reason; an empty string collapses to null so we never store
 * a blank. Capped so it can't be used as an unbounded text sink.
 */
export const accountDeletionRequestSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(2000, 'Reason is too long')
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

export type AccountDeletionRequestInput = z.infer<
  typeof accountDeletionRequestSchema
>;
