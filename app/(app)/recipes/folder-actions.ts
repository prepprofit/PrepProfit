'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { isForeignKeyViolation, isUniqueViolation } from '@/lib/db/errors';
import {
  createFolder,
  deleteFolder,
  renameFolder,
  reorderFolder,
} from '@/lib/data/recipe-folders';
import { moveRecipeToFolder } from '@/lib/data/recipes';
import {
  folderCreateSchema,
  folderRenameSchema,
  folderReorderSchema,
  moveRecipeSchema,
} from '@/lib/validation/recipe-folders';
import type { ActionResult } from '@/lib/action-result';

/**
 * Server Actions for recipe folders. RULE #1: org id from Clerk on the server,
 * every write inside `withOrg` (RLS active), Zod validation on the server. Folder
 * mutations only revalidate /recipes (the rail + grid live there).
 */

const DUPLICATE_NAME = 'A folder with that name already exists.';

export async function createFolderAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const parsed = folderCreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid folder name.' };

  const organizationId = await getOrgId();
  try {
    const row = await withOrg(organizationId, (tx) =>
      createFolder(tx, organizationId, parsed.data.name),
    );
    revalidatePath('/recipes');
    return { ok: true, data: { id: row.id } };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: DUPLICATE_NAME };
    throw err;
  }
}

export async function renameFolderAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = folderRenameSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid folder name.' };

  const organizationId = await getOrgId();
  try {
    const row = await withOrg(organizationId, (tx) =>
      renameFolder(tx, organizationId, id, parsed.data.name),
    );
    if (!row) return { ok: false, error: 'Folder not found.' };
    revalidatePath('/recipes');
    return { ok: true, data: undefined };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: DUPLICATE_NAME };
    throw err;
  }
}

export async function reorderFolderAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = folderReorderSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid reorder.' };

  const organizationId = await getOrgId();
  const moved = await withOrg(organizationId, (tx) =>
    reorderFolder(tx, organizationId, id, parsed.data.direction),
  );
  if (!moved) return { ok: false, error: 'Folder not found.' };
  revalidatePath('/recipes');
  return { ok: true, data: undefined };
}

/** Hard-deletes a folder; its recipes fall back to "No folder" (never trashed). */
export async function deleteFolderAction(id: string): Promise<ActionResult> {
  const organizationId = await getOrgId();
  const deleted = await withOrg(organizationId, (tx) =>
    deleteFolder(tx, organizationId, id),
  );
  if (!deleted) return { ok: false, error: 'Folder not found.' };
  revalidatePath('/recipes');
  return { ok: true, data: undefined };
}

/** Files a recipe into a folder, or to "No folder" (folderId = null). */
export async function moveRecipeToFolderAction(
  recipeId: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = moveRecipeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid move.' };

  const organizationId = await getOrgId();
  try {
    const row = await withOrg(organizationId, (tx) =>
      moveRecipeToFolder(tx, organizationId, recipeId, parsed.data.folderId),
    );
    if (!row) return { ok: false, error: 'Recipe not found.' };
  } catch (err) {
    // The composite FK rejects a non-existent or cross-tenant folder.
    if (isForeignKeyViolation(err)) {
      return { ok: false, error: 'Folder not found.' };
    }
    throw err;
  }
  revalidatePath('/recipes');
  revalidatePath(`/recipes/${recipeId}`);
  return { ok: true, data: undefined };
}
