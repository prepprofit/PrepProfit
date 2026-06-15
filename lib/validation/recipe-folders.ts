import { z } from 'zod';

/**
 * Server-side validation for recipe folders and recipe moves. Org id is always
 * derived server-side (RULE #1) — never part of these schemas.
 */

/** A folder name: trimmed, 1–80 chars. Uniqueness per org is enforced by the DB. */
export const folderNameSchema = z.string().trim().min(1).max(80);

export const folderCreateSchema = z.object({ name: folderNameSchema });
export const folderRenameSchema = z.object({ name: folderNameSchema });

/** Manual reordering moves a folder one slot up or down the rail. */
export const folderReorderSchema = z.object({
  direction: z.enum(['up', 'down']),
});

/** Move a recipe into a folder, or to "No folder" (null). */
export const moveRecipeSchema = z.object({
  folderId: z.string().min(1).nullable(),
});

export type FolderCreateInput = z.infer<typeof folderCreateSchema>;
export type FolderRenameInput = z.infer<typeof folderRenameSchema>;
export type FolderReorderInput = z.infer<typeof folderReorderSchema>;
export type MoveRecipeInput = z.infer<typeof moveRecipeSchema>;
