import { z } from 'zod';

/**
 * Server-side validation for suppliers (Sprint 7). CLAUDE.md: Zod on all user
 * input, on the server. The org id is never part of the payload — derived from
 * Clerk on the server. Manager-only at the action layer.
 */

/** Optional free-text field → trimmed, '' becomes null. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional();

export const supplierSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: optionalText(160),
  phone: optionalText(40),
  address: optionalText(300),
  taxId: optionalText(60),
  notes: optionalText(1000),
});

export type SupplierFormInput = z.infer<typeof supplierSchema>;

/**
 * Pack units a supplier link may carry — the full {@link Unit} set from lib/units.
 * The data layer checks the chosen unit's dimension matches the ingredient
 * (PACK_UNIT_MISMATCH); this enum only guarantees a KNOWN unit token reaches it.
 */
export const PACK_UNITS = [
  'g',
  'kg',
  'oz',
  'lb',
  'ml',
  'l',
  'floz',
  'cup',
  'count',
] as const;

/**
 * How a supplier expresses the price they quote — see `SupplierPriceBasis` in
 * lib/calculations/purchasePrice.ts. Remembered per supplier so a manager doesn't
 * re-pick it for every ingredient.
 */
export const PRICE_BASES = ['pack', 'inner', 'priced'] as const;

/**
 * Setting/clearing the DEFAULT supplier on an ingredient. `supplierName` is
 * type-to-create (find-or-create on the normalized key). Pack fields are optional
 * but coupled: a price requires both a size and a unit (the DB CHECK enforces this
 * too); the action surfaces INVALID_INPUT when only some are present.
 *
 * `packPriceCents` is the price AS ENTERED, interpreted by `priceBasis` +
 * `priceIncludesVat` — the SERVER normalizes it into the stored whole-pack net price
 * (never the client). Both default to the historical meaning (whole pack, excl.
 * VAT), so a payload that omits them behaves exactly as before.
 */
export const ingredientSupplierSchema = z.object({
  supplierName: z.string().trim().min(1).max(120),
  // Purchasing-only identifiers — never shown in recipes/menus/ingredient lists.
  supplierProductName: optionalText(160),
  supplierSku: optionalText(60),
  // Every pack/price field is independently optional: omitted = keep what the entry
  // stores, null = clear it. The server prices only a complete pack and says so.
  // Case quantity: inner units per purchase.
  unitsPerPack: z.number().int().positive().max(100_000).nullable().optional(),
  // Size of ONE inner unit.
  packSize: z.number().positive().max(1_000_000).nullable().optional(),
  packUnit: z.enum(PACK_UNITS).nullable().optional(),
  // The quoted price in integer cents, as entered (see the doc above).
  packPriceCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  priceBasis: z.enum(PRICE_BASES).optional(),
  priceIncludesVat: z.boolean().optional(),
  // Legacy purchase VAT band id ('' clears); the editor now sends `vatRateBps`.
  vatCategoryId: z.union([z.literal(''), z.string().uuid()]).optional(),
  // This entry's purchase VAT rate in basis points (0 = a deliberate 0% rate).
  // null clears it; omitted = untouched (the suggested default is not stored).
  vatRateBps: z.number().int().min(0).max(10_000).nullable().optional(),
});

export type IngredientSupplierInput = z.infer<typeof ingredientSupplierSchema>;
