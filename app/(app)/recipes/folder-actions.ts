'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { isForeignKeyViolation, isUniqueViolation } from '@/lib/db/errors';
import {
  createFolder,
  deleteFolder,
  updateFolder,
  reorderFolder,
  moveFolder,
} from '@/lib/data/recipe-folders';
import { moveRecipeToFolder } from '@/lib/data/recipes';
import {
  folderCreateSchema,
  folderUpdateSchema,
  folderReorderSchema,
  folderMoveSchema,
  moveRecipeSchema,
} from '@/lib/validation/recipe-folders';
import { unexpected } from '@/lib/observability';
import type { ActionResult } from '@/lib/action-result';

/**
 * Server Actions for recipe folders. RULE #1: org id from Clerk on the server,
 * every write inside `withOrg` (RLS active), Zod validation on the server. Folder
 * mutations only revalidate /recipes (the rail + grid live there).
 */

export async function createFolderAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const parsed = folderCreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  try {
    const row = await withOrg(organizationId, (tx) =>
      createFolder(
        tx,
        organizationId,
        parsed.data.name,
        parsed.data.icon ?? null,
        parsed.data.parentId ?? null,
      ),
    );
    revalidatePath('/recipes');
    return { ok: true, data: { id: row.id } };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, code: 'DUPLICATE_NAME' };
    if (isForeignKeyViolation(err)) return { ok: false, code: 'NOT_FOUND' };
    return unexpected('createFolderAction', err, organizationId);
  }
}

export async function renameFolderAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = folderUpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  try {
    const row = await withOrg(organizationId, (tx) =>
      updateFolder(tx, organizationId, id, parsed.data.name, parsed.data.icon ?? null),
    );
    if (!row) return { ok: false, code: 'NOT_FOUND' };
    revalidatePath('/recipes');
    return { ok: true, data: undefined };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, code: 'DUPLICATE_NAME' };
    return unexpected('renameFolderAction', err, organizationId);
  }
}

export async function reorderFolderAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = folderReorderSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const moved = await withOrg(organizationId, (tx) =>
    reorderFolder(tx, organizationId, id, parsed.data.direction),
  );
  if (!moved) return { ok: false, code: 'NOT_FOUND' };
  revalidatePath('/recipes');
  return { ok: true, data: undefined };
}

/**
 * Hard-deletes a folder; its DIRECT recipes fall back to "No folder" (never
 * trashed). Blocked with `FOLDER_HAS_SUBFOLDERS` while the folder still has
 * subfolders — move or delete them first.
 */
export async function deleteFolderAction(id: string): Promise<ActionResult> {
  const organizationId = await getOrgId();
  const result = await withOrg(organizationId, (tx) =>
    deleteFolder(tx, organizationId, id),
  );
  if (result.blockedBySubfolders) return { ok: false, code: 'FOLDER_HAS_SUBFOLDERS' };
  if (!result.deleted) return { ok: false, code: 'NOT_FOUND' };
  revalidatePath('/recipes');
  return { ok: true, data: undefined };
}

/** Moves a folder to a new parent, or to "Top level" (parentId = null). */
export async function moveFolderAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ previousParentId: string | null }>> {
  const parsed = folderMoveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  try {
    const result = await withOrg(organizationId, (tx) =>
      moveFolder(tx, organizationId, id, parsed.data.parentId),
    );
    if (!result.ok) {
      return {
        ok: false,
        code: result.reason === 'NOT_FOUND' ? 'NOT_FOUND' : 'FOLDER_CYCLE',
      };
    }
    revalidatePath('/recipes');
    return { ok: true, data: { previousParentId: result.previousParentId } };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, code: 'DUPLICATE_NAME' };
    return unexpected('moveFolderAction', err, organizationId);
  }
}

/** Files a recipe into a folder, or to "No folder" (folderId = null). */
export async function moveRecipeToFolderAction(
  recipeId: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = moveRecipeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  try {
    const row = await withOrg(organizationId, (tx) =>
      moveRecipeToFolder(tx, organizationId, recipeId, parsed.data.folderId),
    );
    if (!row) return { ok: false, code: 'NOT_FOUND' };
  } catch (err) {
    // The composite FK rejects a non-existent or cross-tenant folder.
    if (isForeignKeyViolation(err)) {
      return { ok: false, code: 'NOT_FOUND' };
    }
    return unexpected('moveRecipeToFolderAction', err, organizationId);
  }
  revalidatePath('/recipes');
  revalidatePath(`/recipes/${recipeId}`);
  return { ok: true, data: undefined };
}
