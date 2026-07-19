import { z } from 'zod';
import { folderIconSchema, folderNameSchema } from '@/lib/validation/recipe-folders';

/**
 * Server-side validation for recipe books and the library bulk actions
 * (Fase 7). Org id is always derived server-side (RULE #1) — never part of
 * these schemas. Books share the folder name/icon rules (same rail, same
 * curated emoji palette).
 */

export const bookCreateSchema = z.object({
  name: folderNameSchema,
  icon: folderIconSchema.optional(),
});

export const bookUpdateSchema = z.object({
  name: folderNameSchema,
  icon: folderIconSchema.optional(),
});

export const bookReorderSchema = z.object({
  direction: z.enum(['up', 'down']),
});

/**
 * Bulk selections are BOUNDED (max 200) so a forged payload cannot turn one
 * action into an unbounded scan/lock storm. Ids are deduped server-side.
 */
export const bulkRecipeIdsSchema = z
  .array(z.string().min(1).max(64))
  .min(1)
  .max(200)
  .transform((ids) => [...new Set(ids)]);

export const bulkBookMembershipSchema = z.object({
  bookId: z.string().min(1).max(64),
  recipeIds: bulkRecipeIdsSchema,
});

export const bulkTrashSchema = z.object({
  recipeIds: bulkRecipeIdsSchema,
});

export type BookCreateInput = z.infer<typeof bookCreateSchema>;
export type BookUpdateInput = z.infer<typeof bookUpdateSchema>;
export type BookReorderInput = z.infer<typeof bookReorderSchema>;
export type BulkBookMembershipInput = z.infer<typeof bulkBookMembershipSchema>;
export type BulkTrashInput = z.infer<typeof bulkTrashSchema>;
