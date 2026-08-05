import { z } from 'zod';

/**
 * Purchase VAT categories (per org). The rate is ENTERED as a percentage (0..100)
 * and STORED as integer basis points — the same convention as the sales rate in
 * `lib/validation/org-settings.ts`. Basis points because 25.5% is not expressible
 * in whole percent.
 */

export const vatCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    ratePercent: z.coerce.number().min(0).max(100),
  })
  .transform((v) => ({
    name: v.name,
    rateBps: Math.round(v.ratePercent * 100),
  }));

export type VatCategoryInput = z.infer<typeof vatCategorySchema>;

/** Percent string for an input field: 2550 → "25.5". */
export function bpsToRatePercent(bps: number): string {
  return String(Math.round(bps) / 100);
}
