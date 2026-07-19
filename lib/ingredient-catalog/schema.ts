import { z } from 'zod';
import { allergenSlugSchema, presenceSchema } from '@/lib/validation/allergens';

/**
 * Seed ingredient catalogue — schema and types
 * (docs/ingredient-seed-catalog-plan.md).
 *
 * The catalogue is GLOBAL, read-only "pure data" living in the repo (like
 * ALLERGEN_CATALOG / CATEGORY_SEED), generated offline by
 * scripts/generate-ingredient-catalog.ts from the USDA FDC SR Legacy dump
 * (CC0) plus hand-curated overrides. It is NOT business data: no
 * organization_id, no RLS, never sent to the client wholesale — searched
 * server-side only.
 *
 * Hard rules enforced downstream: creating from the catalogue ALWAYS yields
 * priceCents = 0 + needsPricing = true (prices never come from the catalogue),
 * and allergen tags are seeded UNREVIEWED (no review provenance).
 */

export const catalogDimensionSchema = z.enum(['weight', 'volume', 'count']);

export const catalogEntrySchema = z.object({
  /** Stable slug — never repurposed for a different food across regenerations. */
  id: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
  nameEn: z.string().min(1).max(80),
  /** Extra searchable names (EN in v1; PT planned as a future data PR). */
  aliases: z.array(z.string().min(1).max(80)).max(10),
  /** Optional PT name — reserved for the future PT data PR (D2). */
  namePt: z.string().min(1).max(80).optional(),
  dimension: catalogDimensionSchema,
  /** Source FDC category label, used only for display/grouping. */
  category: z.string().min(1).max(80),
  /** Typical allergens; seeded as UNREVIEWED tags on the created ingredient. */
  allergens: z
    .array(z.object({ allergen: allergenSlugSchema, presence: presenceSchema }))
    .max(14),
  /** Suggested USDA FDC id for the (opt-in, separate) nutrition import. */
  suggestedFdcId: z.number().int().positive().nullable(),
});

export const catalogSchema = z
  .array(catalogEntrySchema)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate catalog id: ${entry.id}`,
        });
      }
      seen.add(entry.id);
    }
  });

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;
