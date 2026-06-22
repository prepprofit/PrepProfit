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
 * Setting/clearing the DEFAULT supplier on an ingredient. `supplierName` is
 * type-to-create (find-or-create on the normalized key). Pack fields are optional
 * but coupled: a price requires both a size and a unit (the DB CHECK enforces this
 * too); the action surfaces INVALID_INPUT when only some are present.
 */
export const ingredientSupplierSchema = z
  .object({
    supplierName: z.string().trim().min(1).max(120),
    packSize: z.number().positive().max(1_000_000).optional(),
    packUnit: z.enum(PACK_UNITS).optional(),
    // Whole-pack price in integer cents.
    packPriceCents: z.number().int().min(0).max(100_000_000).optional(),
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
  );

export type IngredientSupplierInput = z.infer<typeof ingredientSupplierSchema>;
