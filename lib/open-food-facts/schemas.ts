import { z } from 'zod';

/**
 * Zod schemas for the Open Food Facts v3 product-read response (plan §7).
 *
 * DELIBERATELY TOLERANT of untrusted input: unknown top-level and unknown
 * `nutriments` keys are IGNORED (Zod strips them), numeric fields accept a
 * number or a numeric string and coerce, and a bad value becomes `null` rather
 * than rejecting the whole payload. Only a structurally incompatible response
 * (e.g. `product` not an object) fails the parse → the caller maps that to
 * `EXTERNAL_PRODUCT_INVALID`.
 *
 * We read nutriments from the FLAT per-basis keys (`*_100g`) plus
 * `nutrition_data_per`, which the v3 read endpoint continues to expose — see
 * `docs/adr-open-food-facts-integration.md`. Localized `product_name_<lang>`
 * fields are captured via `.catchall` for the language fallback in normalize.
 */

/** number | numeric-string → number; anything else → null (never throws). */
const looseNumber = z.preprocess((v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}, z.number().nullable());

/** Flat per-basis nutriments we consume; unknown keys are stripped. */
const nutrimentsSchema = z
  .object({
    'energy-kcal_100g': looseNumber.optional(),
    'energy-kj_100g': looseNumber.optional(),
    fat_100g: looseNumber.optional(),
    'saturated-fat_100g': looseNumber.optional(),
    carbohydrates_100g: looseNumber.optional(),
    sugars_100g: looseNumber.optional(),
    fiber_100g: looseNumber.optional(),
    proteins_100g: looseNumber.optional(),
    salt_100g: looseNumber.optional(),
    sodium_100g: looseNumber.optional(),
  })
  .nullish();

/**
 * The product object. `.catchall` keeps unknown keys (e.g. `product_name_en`,
 * `product_name_pt`) so normalize can fall back across languages, while the
 * declared fields stay strongly typed.
 */
const productSchema = z
  .object({
    code: z.string().nullish(),
    product_name: z.string().nullish(),
    generic_name: z.string().nullish(),
    brands: z.string().nullish(),
    quantity: z.string().nullish(),
    lang: z.string().nullish(),
    product_type: z.string().nullish(),
    countries_tags: z.array(z.string()).nullish(),
    nutrition_data_per: z.string().nullish(),
    serving_size: z.string().nullish(),
    rev: z.union([z.number(), z.string()]).nullish(),
    last_modified_t: z.union([z.number(), z.string()]).nullish(),
    nutriments: nutrimentsSchema,
  })
  .catchall(z.unknown());

export const offResponseSchema = z
  .object({
    code: z.union([z.number(), z.string()]).nullish(),
    status: z.string().nullish(),
    result: z
      .object({ id: z.string().nullish(), name: z.string().nullish() })
      .nullish(),
    product: productSchema.nullish(),
    errors: z.array(z.unknown()).nullish(),
    warnings: z.array(z.unknown()).nullish(),
  })
  .catchall(z.unknown());

export type OffResponse = z.infer<typeof offResponseSchema>;
export type OffProduct = z.infer<typeof productSchema>;

/** True when the response signals a not-found lookup (v3 `failure` status). */
export function isNotFound(res: OffResponse): boolean {
  if (res.status === 'failure') return true;
  if (res.result?.id === 'product_not_found') return true;
  return res.product == null;
}
