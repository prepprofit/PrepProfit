'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { isUniqueViolation } from '@/lib/db/errors';
import { unexpected } from '@/lib/observability';
import {
  createDish,
  createMenuFolder,
  deleteMenuFolder,
  duplicateDish,
  getMenuById,
  loadStoredRecipeLines,
  markDishOpened,
  renameMenuFolder,
  searchDishes,
  softDeleteMenu,
  updateDish,
  type DishSearchResult,
  type SaveDishOutcome,
} from '@/lib/data/menus';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import {
  dishCopySchema,
  dishSchema,
  dishSearchSchema,
  menuFolderSchema,
  recipeLinesUseGrams,
} from '@/lib/validation/menus';
import type { ActionErrorCode, ActionResult } from '@/lib/action-result';

/**
 * Server Actions for the Menu section (folders + Dish Builder). Dish and folder
 * MUTATIONS are manager-only (a dish carries its selling price) and return FORBIDDEN
 * before any data access. Search and "mark opened" are money-free and open to both
 * roles. Canonical order: RBAC → Zod → withOrg(mutation + audit) → revalidate.
 * RULE #1: org id from Clerk, never the client.
 *
 * Audit metadata is ids, counts, flags and changed field names only — NEVER a price.
 */

function revalidateMenus(id?: string): void {
  revalidatePath('/menus', 'layout');
  if (id) revalidatePath(`/menus/${id}`);
  revalidatePath('/trash');
}

const SAVE_ERRORS: Record<Exclude<SaveDishOutcome['status'], 'ok'> | 'grams_required', ActionErrorCode> = {
  not_found: 'NOT_FOUND',
  grams_required: 'MENU_RECIPE_GRAMS_REQUIRED',
  invalid_recipe: 'MENU_RECIPE_INVALID',
  invalid_ingredient: 'MENU_INGREDIENT_INVALID',
  invalid_folder: 'MENU_FOLDER_INVALID',
};

export async function createDishAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = dishSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  if (!recipeLinesUseGrams(parsed.data.recipeLines, [])) {
    return { ok: false, code: 'MENU_RECIPE_GRAMS_REQUIRED' };
  }

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await createDish(tx, organizationId, parsed.data);
    if (result.status === 'ok') {
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'menu.create',
        entityType: 'menu',
        entityId: result.menu.id,
        metadata: {
          recipeLineCount: parsed.data.recipeLines.length,
          ingredientLineCount: parsed.data.ingredientLines.length,
          extraCount: parsed.data.extras.length,
          labourEntered: parsed.data.labour !== null,
          outputUnit: parsed.data.output.unit,
          priceSet: parsed.data.sellingPriceCents !== null,
        },
      });
    }
    return result;
  });
  if (outcome.status !== 'ok') return { ok: false, code: SAVE_ERRORS[outcome.status] };
  revalidateMenus(outcome.menu.id);
  return { ok: true, data: { id: outcome.menu.id } };
}

export async function updateDishAction(id: string, input: unknown): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = dishSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const outcome = await withOrg(organizationId, async (tx) => {
    const before = await getMenuById(tx, organizationId, id);
    if (!before) return { status: 'not_found' } as const;
    const stored = await loadStoredRecipeLines(tx, organizationId, id);
    if (!recipeLinesUseGrams(parsed.data.recipeLines, stored)) {
      return { status: 'grams_required' } as const;
    }
    const result = await updateDish(tx, organizationId, id, parsed.data);
    if (result.status !== 'ok') return result;

    const next = parsed.data;
    const changedFields = [
      before.name !== next.name && 'name',
      before.folderId !== next.folderId && 'folder',
      (before.outputUnit !== next.output.unit ||
        before.outputQuantity !== result.menu.outputQuantity) &&
        'output',
      before.sellingPriceCents !== next.sellingPriceCents && 'sellingPrice',
      before.priceBasis !== next.priceBasis && 'priceBasis',
      before.vatRateBps !== next.vatRateBps && 'vatRate',
      (before.labourHours !== result.menu.labourHours ||
        before.labourHourlyCents !== result.menu.labourHourlyCents) &&
        'labour',
      (before.notes ?? null) !== (next.notes ?? null) && 'notes',
    ].filter((f): f is string => typeof f === 'string');

    await writeAuditEvent(tx, organizationId, actor, {
      action: 'menu.update',
      entityType: 'menu',
      entityId: id,
      metadata: {
        recipeLineCount: next.recipeLines.length,
        ingredientLineCount: next.ingredientLines.length,
        extraCount: next.extras.length,
        labourEntered: next.labour !== null,
        priceChanged: before.sellingPriceCents !== next.sellingPriceCents,
        changedFields,
      },
    });
    return result;
  });
  if (outcome.status !== 'ok') return { ok: false, code: SAVE_ERRORS[outcome.status] };
  revalidateMenus(id);
  return { ok: true, data: undefined };
}

/**
 * "Make a copy" — manager-only. Creates an independent product (composition, output,
 * labour, extras, price) the chef then renames and reviews; the original is untouched.
 */
export async function duplicateDishAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = dishCopySchema.safeParse(input);
  if (typeof id !== 'string' || id.trim() === '' || !parsed.success) {
    return { ok: false, code: 'INVALID_INPUT' };
  }

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await duplicateDish(tx, organizationId, id, parsed.data.name);
    if (result.status === 'ok') {
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'menu.create',
        entityType: 'menu',
        entityId: result.menu.id,
        metadata: { copiedFrom: id },
      });
    }
    return result;
  });
  if (outcome.status !== 'ok') return { ok: false, code: 'NOT_FOUND' };
  revalidateMenus(outcome.menu.id);
  return { ok: true, data: { id: outcome.menu.id } };
}

/** Soft-delete (trash) an active dish — manager-only. */
export async function deleteMenuAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  const actor = await auditActor();
  const row = await withOrg(organizationId, async (tx) => {
    const deleted = await softDeleteMenu(tx, organizationId, id);
    if (deleted) {
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'menu.delete',
        entityType: 'menu',
        entityId: id,
      });
    }
    return deleted;
  });
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  revalidateMenus(id);
  return { ok: true, data: undefined };
}

// ── Folders (manager-only) ───────────────────────────────────────────────────

export async function createMenuFolderAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = menuFolderSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  try {
    const row = await withOrg(organizationId, (tx) =>
      createMenuFolder(tx, organizationId, parsed.data.name),
    );
    revalidateMenus();
    return { ok: true, data: { id: row.id } };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, code: 'DUPLICATE_NAME' };
    return unexpected('createMenuFolderAction', err, organizationId);
  }
}

export async function renameMenuFolderAction(id: string, input: unknown): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = menuFolderSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  try {
    const row = await withOrg(organizationId, (tx) =>
      renameMenuFolder(tx, organizationId, id, parsed.data.name),
    );
    if (!row) return { ok: false, code: 'NOT_FOUND' };
    revalidateMenus();
    return { ok: true, data: undefined };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, code: 'DUPLICATE_NAME' };
    return unexpected('renameMenuFolderAction', err, organizationId);
  }
}

/** Delete a folder; its dishes move to Unfiled (never deleted). */
export async function deleteMenuFolderAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  const result = await withOrg(organizationId, (tx) => deleteMenuFolder(tx, organizationId, id));
  if (!result.deleted) return { ok: false, code: 'NOT_FOUND' };
  revalidateMenus();
  return { ok: true, data: undefined };
}

// ── Money-free (both roles) ──────────────────────────────────────────────────

/** Name search across every dish, whatever folder it lives in. */
export async function searchDishesAction(
  input: unknown,
): Promise<ActionResult<DishSearchResult[]>> {
  const parsed = dishSearchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  const organizationId = await getOrgId();
  const results = await withOrg(organizationId, (tx) =>
    searchDishes(tx, organizationId, parsed.data.query),
  );
  return { ok: true, data: results };
}

/** Stamp "last opened" (drives the Last opened sort). No revalidation needed. */
export async function markDishOpenedAction(id: string): Promise<ActionResult> {
  if (typeof id !== 'string' || id.trim() === '') return { ok: false, code: 'INVALID_INPUT' };
  const organizationId = await getOrgId();
  await withOrg(organizationId, (tx) => markDishOpened(tx, organizationId, id));
  return { ok: true, data: undefined };
}
