import { z } from 'zod';

/**
 * Server-side validation for recipe folders and recipe moves. Org id is always
 * derived server-side (RULE #1) — never part of these schemas.
 */

/** A folder name: trimmed, 1–80 chars. Uniqueness per org is enforced by the DB. */
export const folderNameSchema = z.string().trim().min(1).max(80);

/**
 * Curated chef/kitchen palette for folder icons — the single source of truth
 * shared by the picker UI and the server guard. Only these emojis (or null,
 * meaning the default Folder glyph) are accepted; the client can never store
 * arbitrary text.
 */
export const FOLDER_ICONS = [
  // Prep & cooking
  '🍳', '🔪', '🍴', '🥄', '🍽️', '🧑‍🍳',
  // Breads & baking
  '🍞', '🥖', '🥐', '🥨', '🧇', '🥞',
  // Meat & dairy
  '🥩', '🍗', '🥓', '🍖', '🥚', '🧀',
  // Seafood
  '🐟', '🦐', '🦞', '🦀', '🦑', '🍣',
  // Vegetables
  '🥦', '🥕', '🌽', '🍄', '🧄', '🧅',
  '🍅', '🍆', '🥑', '🌶️', '🥒', '🥗',
  // Fruit
  '🍎', '🍓', '🍋', '🍌', '🍇', '🍑',
  // Desserts & sweets
  '🍰', '🧁', '🍪', '🍩', '🍫', '🍮',
  // Dishes
  '🍕', '🍝', '🍜', '🌮', '🥙', '🍱',
  // Drinks & pantry
  '☕', '🍷', '🍵', '🍺', '🥤', '🍯',
] as const;

export const folderIconSchema = z.enum(FOLDER_ICONS).nullable();

/** `parentId` is the folder to create/find this folder inside; omitted/null = top level. */
export const folderCreateSchema = z.object({
  name: folderNameSchema,
  icon: folderIconSchema.optional(),
  parentId: z.string().min(1).nullable().optional(),
});

/** Editing an existing folder: name plus its (possibly cleared) icon. */
export const folderUpdateSchema = z.object({
  name: folderNameSchema,
  icon: folderIconSchema.optional(),
});

/** Manual reordering moves a folder one slot up or down among its siblings. */
export const folderReorderSchema = z.object({
  direction: z.enum(['up', 'down']),
});

/** Move a folder to a new parent, or to "Top level" (null). */
export const folderMoveSchema = z.object({
  parentId: z.string().min(1).nullable(),
});

/** Move a recipe into a folder, or to "No folder" (null). */
export const moveRecipeSchema = z.object({
  folderId: z.string().min(1).nullable(),
});

export type FolderCreateInput = z.infer<typeof folderCreateSchema>;
export type FolderUpdateInput = z.infer<typeof folderUpdateSchema>;
export type FolderIcon = (typeof FOLDER_ICONS)[number];
export type FolderReorderInput = z.infer<typeof folderReorderSchema>;
export type FolderMoveInput = z.infer<typeof folderMoveSchema>;
export type MoveRecipeInput = z.infer<typeof moveRecipeSchema>;
