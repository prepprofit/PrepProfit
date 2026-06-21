import { z } from 'zod';
import { MAX_TAX_RATE_BPS } from '@/lib/calculations/tax';
import { dateStringSchema } from '@/lib/validation/transactions';

/**
 * Server-side validation for organization settings. RULE #1: the org id is never
 * part of this payload — it is derived from Clerk on the server. We validate only
 * the user-editable fields (currency + measurement system).
 */

/** Curated ISO-4217 codes offered in the UI. Money is formatted with these via
 * Intl.NumberFormat (lib/format/money.ts); there is NO currency conversion. */
export const CURRENCY_CODES = [
  'EUR',
  'USD',
  'GBP',
  'CHF',
  'SEK',
  'NOK',
  'DKK',
  'PLN',
  'CZK',
  'CAD',
  'AUD',
  'NZD',
  'JPY',
  'BRL',
  'MXN',
  'ZAR',
  'AED',
  'SGD',
  'HKD',
  'INR',
] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

/** Code + human label for the settings <select>. */
export const CURRENCIES: ReadonlyArray<{ code: CurrencyCode; label: string }> = [
  { code: 'EUR', label: 'Euro (€)' },
  { code: 'USD', label: 'US Dollar ($)' },
  { code: 'GBP', label: 'British Pound (£)' },
  { code: 'CHF', label: 'Swiss Franc (CHF)' },
  { code: 'SEK', label: 'Swedish Krona (kr)' },
  { code: 'NOK', label: 'Norwegian Krone (kr)' },
  { code: 'DKK', label: 'Danish Krone (kr)' },
  { code: 'PLN', label: 'Polish Złoty (zł)' },
  { code: 'CZK', label: 'Czech Koruna (Kč)' },
  { code: 'CAD', label: 'Canadian Dollar (C$)' },
  { code: 'AUD', label: 'Australian Dollar (A$)' },
  { code: 'NZD', label: 'New Zealand Dollar (NZ$)' },
  { code: 'JPY', label: 'Japanese Yen (¥)' },
  { code: 'BRL', label: 'Brazilian Real (R$)' },
  { code: 'MXN', label: 'Mexican Peso (MX$)' },
  { code: 'ZAR', label: 'South African Rand (R)' },
  { code: 'AED', label: 'UAE Dirham (د.إ)' },
  { code: 'SGD', label: 'Singapore Dollar (S$)' },
  { code: 'HKD', label: 'Hong Kong Dollar (HK$)' },
  { code: 'INR', label: 'Indian Rupee (₹)' },
];

export const MEASUREMENT_SYSTEMS = ['metric', 'imperial'] as const;

/** Trim then coerce empty string → null, so a cleared field is stored as NULL. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .default(null);

/**
 * Seller logo URL embedded in generated documents (invoice PDF/print). Restricted
 * to `https://` so we never render `http`, `data:`, `javascript:` or other schemes
 * into the document header. Empty → null.
 */
const logoUrlSchema = z
  .string()
  .trim()
  .max(500)
  .transform((s) => (s === '' ? null : s))
  .nullable()
  .default(null)
  .refine(
    (v) => v === null || /^https:\/\//i.test(v),
    'Logo URL must start with https://',
  )
  .refine((v) => {
    if (v === null) return true;
    try {
      const u = new URL(v);
      return u.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Logo URL must be a valid https URL');

export const orgSettingsSchema = z.object({
  currency: z.enum(CURRENCY_CODES),
  measurementSystem: z.enum(MEASUREMENT_SYSTEMS),
  // Seller identity for generated documents (Sprint 3.5A). All optional.
  businessName: optionalText(120),
  businessAddress: optionalText(400),
  businessTaxId: optionalText(60),
  businessEmail: z
    .union([z.literal(''), z.string().trim().email().max(200)])
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .default(null),
  businessLogoUrl: logoUrlSchema,
  // Sales fiscal config (Sprint F5). The tax rate is ENTERED as a percentage
  // (0..100) and STORED as integer basis points; empty/cleared → null ("not
  // configured", no silent 0%). Capped 0..10000 bps (= 0%..100%).
  defaultTaxRateBps: z
    .preprocess(
      (v) => (v == null || v === '' ? null : v),
      z.coerce.number().min(0).max(100).nullable(),
    )
    .transform((percent) =>
      percent == null
        ? null
        : Math.min(MAX_TAX_RATE_BPS, Math.round(percent * 100)),
    ),
  // Financial-only mode start date: a real calendar date 'YYYY-MM-DD' or null.
  stockControlStartDate: z.preprocess(
    (v) => (v == null || v === '' ? null : v),
    dateStringSchema.nullable(),
  ),
});

export type OrgSettingsInput = z.infer<typeof orgSettingsSchema>;
