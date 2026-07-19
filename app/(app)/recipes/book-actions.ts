'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { isForeignKeyViolation, isUniqueViolation } from '@/lib/db/errors';
import {
  addRecipesToBook,
  createBook,
  deleteBook,
  removeRecipesFromBook,
  reorderBook,
  setRecipeBooks,
  updateBook,
} from '@/lib/data/recipe-books';
import { softDeleteRecipe } from '@/lib/data/recipes';
import {
  countActiveParentsUsingComponent,
  lockRecipeComponentEndpoints,
} from '@/lib/data/recipe-components';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import {
  bookCreateSchema,
  bookReorderSchema,
  bookUpdateSchema,
  bulkBookMembershipSchema,
  bulkRecipeIdsSchema,
  bulkTrashSchema,
} from '@/lib/validation/recipe-books';
import { unexpected } from '@/lib/observability';
import type { ActionResult } from '@/lib/action-result';

/**
 * Server Actions for recipe books + the library bulk actions (Fase 7).
 * RULE #1: org id from Clerk on the server, every write inside one `withOrg`
 * transaction (RLS active), Zod validation on the server. Books are an
 * OPERATIONAL organizer (like folders): both roles may manage them — no money
 * is ever involved here.
 */

export async function createBookAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const parsed = bookCreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  try {
    const row = await withOrg(organizationId, (tx) =>
      createBook(tx, organizationId, parsed.data.name, parsed.data.icon ?? null),
    );
    revalidatePath('/recipes');
    return { ok: true, data: { id: row.id } };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, code: 'DUPLICATE_NAME' };
    return unexpected('createBookAction', err, organizationId);
  }
}

export async function renameBookAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = bookUpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  try {
    const row = await withOrg(organizationId, (tx) =>
      updateBook(tx, organizationId, id, parsed.data.name, parsed.data.icon ?? null),
    );
    if (!row) return { ok: false, code: 'NOT_FOUND' };
    revalidatePath('/recipes');
    return { ok: true, data: undefined };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, code: 'DUPLICATE_NAME' };
    return unexpected('renameBookAction', err, organizationId);
  }
}

export async function reorderBookAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = bookReorderSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const moved = await withOrg(organizationId, (tx) =>
    reorderBook(tx, organizationId, id, parsed.data.direction),
  );
  if (!moved) return { ok: false, code: 'NOT_FOUND' };
  revalidatePath('/recipes');
  return { ok: true, data: undefined };
}

/** Hard-deletes a book; entries cascade, recipes are untouched. */
export async function deleteBookAction(id: string): Promise<ActionResult> {
  const organizationId = await getOrgId();
  const deleted = await withOrg(organizationId, (tx) =>
    deleteBook(tx, organizationId, id),
  );
  if (!deleted) return { ok: false, code: 'NOT_FOUND' };
  revalidatePath('/recipes');
  return { ok: true, data: undefined };
}

/** Atomically replaces ONE recipe's book memberships (workspace/library edit). */
export async function setRecipeBooksAction(
  recipeId: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = bulkRecipeIdsSchema.safeParse(input);
  // Reuse the bounded-ids schema for the BOOK id list of one recipe.
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  try {
    const ok = await withOrg(organizationId, (tx) =>
      setRecipeBooks(tx, organizationId, recipeId, parsed.data),
    );
    if (!ok) return { ok: false, code: 'NOT_FOUND' };
  } catch (err) {
    if (isForeignKeyViolation(err)) return { ok: false, code: 'NOT_FOUND' };
    return unexpected('setRecipeBooksAction', err, organizationId);
  }
  revalidatePath('/recipes');
  return { ok: true, data: undefined };
}

export type BulkActionSummary = {
  /** Recipes the write actually reached (active, same-org). */
  affected: number;
  /** Selected but missing/trashed — reported, never silently dropped. */
  skipped: number;
};

export async function addRecipesToBookAction(
  input: unknown,
): Promise<ActionResult<BulkActionSummary>> {
  const parsed = bulkBookMembershipSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  try {
    const result = await withOrg(organizationId, (tx) =>
      addRecipesToBook(tx, organizationId, parsed.data.bookId, parsed.data.recipeIds),
    );
    revalidatePath('/recipes');
    return {
      ok: true,
      data: {
        affected: result.affectedIds.length,
        skipped: result.skippedIds.length,
      },
    };
  } catch (err) {
    // The composite FK rejects a non-existent or cross-tenant book.
    if (isForeignKeyViolation(err)) return { ok: false, code: 'NOT_FOUND' };
    return unexpected('addRecipesToBookAction', err, organizationId);
  }
}

export async function removeRecipesFromBookAction(
  input: unknown,
): Promise<ActionResult<BulkActionSummary>> {
  const parsed = bulkBookMembershipSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  try {
    const result = await withOrg(organizationId, (tx) =>
      removeRecipesFromBook(
        tx,
        organizationId,
        parsed.data.bookId,
        parsed.data.recipeIds,
      ),
    );
    revalidatePath('/recipes');
    return {
      ok: true,
      data: {
        affected: result.affectedIds.length,
        skipped: result.skippedIds.length,
      },
    };
  } catch (err) {
    return unexpected('removeRecipesFromBookAction', err, organizationId);
  }
}

export type BulkTrashSummary = {
  trashed: number;
  /** Active recipes blocked because an active parent uses them as a component. */
  blocked: number;
  /** Selected but missing or already trashed. */
  skipped: number;
};

/**
 * Bulk soft-delete (library multi-select). One transaction; each recipe gets
 * the SAME guard as the single trash action (an active parent using it as a
 * component blocks it), and the outcome is reported honestly per bucket —
 * a partial result is success WITH counts, never a silent drop. Audited
 * (`recipe.bulkTrash`) because one call can trash up to 200 recipes.
 */
export async function bulkTrashRecipesAction(
  input: unknown,
): Promise<ActionResult<BulkTrashSummary>> {
  const parsed = bulkTrashSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  try {
    const summary = await withOrg(organizationId, async (tx) => {
      // Serializes against concurrent component-adds for the whole selection
      // (same id-ordered lock discipline as the single trash action).
      await lockRecipeComponentEndpoints(tx, organizationId, parsed.data.recipeIds);

      const trashedIds: string[] = [];
      let blocked = 0;
      let skipped = 0;
      for (const recipeId of parsed.data.recipeIds) {
        if (
          (await countActiveParentsUsingComponent(tx, organizationId, recipeId)) > 0
        ) {
          blocked += 1;
          continue;
        }
        const row = await softDeleteRecipe(tx, organizationId, recipeId);
        if (row) trashedIds.push(recipeId);
        else skipped += 1;
      }

      if (trashedIds.length > 0) {
        await writeAuditEvent(tx, organizationId, actor, {
          action: 'recipe.bulkTrash',
          entityType: 'recipe',
          metadata: {
            trashed: trashedIds.length,
            blocked,
            skipped,
            trashedIds,
          },
        });
      }
      return { trashed: trashedIds.length, blocked, skipped };
    });
    revalidatePath('/recipes');
    revalidatePath('/dashboard');
    revalidatePath('/trash');
    return { ok: true, data: summary };
  } catch (err) {
    return unexpected('bulkTrashRecipesAction', err, organizationId);
  }
}
