import { z } from 'zod';

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

export const orgSettingsSchema = z.object({
  currency: z.enum(CURRENCY_CODES),
  measurementSystem: z.enum(MEASUREMENT_SYSTEMS),
});

export type OrgSettingsInput = z.infer<typeof orgSettingsSchema>;
