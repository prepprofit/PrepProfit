import { z } from 'zod';

/**
 * Server-side validation for the Profit section (Hour Engine). CLAUDE.md: Zod on
 * all user input, on the server; the org id is never part of the payload. Money is
 * integer cents, rates/percentages are integer basis points, time is integer
 * minutes/hours. The client converts typed amounts before calling the action; this
 * schema is the authority.
 */

/** €1,000,000/month per fixed-cost line is far beyond any single kitchen. */
const MAX_MONTHLY_COST_CENTS = 100_000_000;
const monthlyCents = z.number().int().min(0).max(MAX_MONTHLY_COST_CENTS);

export const SALE_UNITS = ['piece', 'kg', 'frame', 'plate'] as const;
export type SaleUnit = (typeof SALE_UNITS)[number];

export const profitSettingsSchema = z.object({
  rentCents: monthlyCents,
  equipmentLeasesCents: monthlyCents,
  equipmentDepreciationCents: monthlyCents,
  insuranceLicensesCents: monthlyCents,
  utilitiesCents: monthlyCents,
  salariedStaffCents: monthlyCents,
  softwareCents: monthlyCents,
  // Hands-on production hours; a month has at most 744 calendar hours.
  productiveHoursPerMonth: z.number().int().min(1).max(744),
  ownerTargetIncomePerHourCents: z.number().int().min(0).max(1_000_000),
  subletEnabled: z.boolean(),
  // 1.0× .. 3.0×
  subletIngredientMultiplierBps: z.number().int().min(10_000).max(30_000),
});
export type ProfitSettingsInput = z.infer<typeof profitSettingsSchema>;

export const productProfitSchema = z
  .object({
    // One week of hands-on time is the ceiling for a single batch.
    batchTimeMinutes: z.number().int().min(1).max(10_080),
    batchYield: z.number().int().min(1).max(1_000_000),
    saleUnit: z.enum(SALE_UNITS),
    // Selling price per unit; null = unpriced.
    sellingPriceCents: z.number().int().min(0).max(10_000_000).nullable(),
    packagingPerBatchCents: z.number().int().min(0).max(10_000_000),
    energyPerBatchCents: z.number().int().min(0).max(10_000_000),
    deliveryPerUnitCents: z.number().int().min(0).max(1_000_000),
    // 0..90%; null = the default.
    wasteBps: z.number().int().min(0).max(9_000).nullable(),
    extraStepMinutes: z.number().int().min(1).max(10_080).nullable(),
    extraStepPriceCents: z.number().int().min(0).max(10_000_000).nullable(),
  })
  .refine(
    // A step is both a time and a price, or neither.
    (v) => (v.extraStepMinutes === null) === (v.extraStepPriceCents === null),
    { message: 'Extra step needs both time and price.', path: ['extraStepMinutes'] },
  );
export type ProductProfitFormInput = z.infer<typeof productProfitSchema>;
