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
export const ingredientSupplierSchema = z
  .object({
    supplierName: z.string().trim().min(1).max(120),
    // Purchasing-only identifiers — never shown in recipes/menus/ingredient lists.
    supplierProductName: optionalText(160),
    supplierSku: optionalText(60),
    // Case quantity: inner units per purchase. Defaults to 1 (single-item purchase).
    unitsPerPack: z.number().int().positive().max(100_000).optional(),
    // Size of ONE inner unit.
    packSize: z.number().positive().max(1_000_000).optional(),
    packUnit: z.enum(PACK_UNITS).optional(),
    // The quoted price in integer cents, as entered (see the doc above).
    packPriceCents: z.number().int().min(0).max(100_000_000).optional(),
    priceBasis: z.enum(PRICE_BASES).optional(),
    priceIncludesVat: z.boolean().optional(),
  })
  .refine(
    // A price is only meaningful with a size + unit (mirrors the DB CHECK).
    (v) =>
      v.packPriceCents === undefined ||
      (v.packSize !== undefined && v.packUnit !== undefined),
    { message: 'A pack price requires a pack size and unit.', path: ['packPriceCents'] },
  )
  .refine(
    // Size and unit travel together (a size with no unit is unusable).
    (v) =>
      (v.packSize === undefined) === (v.packUnit === undefined),
    { message: 'Provide both a pack size and unit, or neither.', path: ['packUnit'] },
  )
  .refine(
    // A case quantity describes a pack — it means nothing without one.
    (v) => v.unitsPerPack === undefined || v.unitsPerPack === 1 || v.packSize !== undefined,
    {
      message: 'A case quantity requires a pack size and unit.',
      path: ['unitsPerPack'],
    },
  );

export type IngredientSupplierInput = z.infer<typeof ingredientSupplierSchema>;
