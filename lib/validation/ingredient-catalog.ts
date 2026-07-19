import { z } from 'zod';
import { DIMENSIONS } from './ingredients';

/**
 * Server-side validation for the seed ingredient catalogue actions
 * (docs/ingredient-seed-catalog-plan.md §5). The payload NEVER carries a
 * price — creation is forced to priceCents 0 + needsPricing true server-side.
 */

export const catalogSearchSchema = z.object({
  term: z.string().trim().min(2).max(80),
});

export const createFromCatalogSchema = z.object({
  catalogId: z.string().trim().min(1).max(80),
  /** Optional user tweaks in the picker before creating. */
  name: z.string().trim().min(1).max(120).optional(),
  dimension: z.enum(DIMENSIONS).optional(),
});

export type CatalogSearchInput = z.infer<typeof catalogSearchSchema>;
export type CreateFromCatalogInput = z.infer<typeof createFromCatalogSchema>;
