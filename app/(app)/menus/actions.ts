'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  createMenu,
  getMenuById,
  softDeleteMenu,
  updateMenu,
  type MenuFields,
  type MenuItemInput,
} from '@/lib/data/menus';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import { menuSchema } from '@/lib/validation/menus';
import type { ActionResult } from '@/lib/action-result';
import type { Menu } from '@/lib/db/schema';

/**
 * Server Actions for the Menus / combos module (Sprint 10). MANAGER-ONLY — every
 * mutation (including the selling price) returns FORBIDDEN before any data access.
 * Kitchen has NO menu mutation action. RULE #1: org id from Clerk, writes inside
 * `withOrg` (RLS), Zod on all input. Canonical order per action: RBAC → Zod →
 * withOrg(mutation + audit in one tx) → revalidate.
 *
 * Audit metadata is ids + counts + a `priceChanged` boolean + changed field names
 * only — NEVER the menu price value or notes (CLAUDE.md).
 */

function revalidateMenus(id?: string): void {
  revalidatePath('/menus');
  if (id) revalidatePath(`/menus/${id}`);
  revalidatePath('/trash');
}

/** Split a validated payload into the menu fields + its line set. */
function toFieldsAndItems(parsed: {
  name: string;
  sellingPriceCents?: number | null;
  notes?: string | null;
  items: MenuItemInput[];
}): { fields: MenuFields; items: MenuItemInput[] } {
  return {
    fields: {
      name: parsed.name,
      sellingPriceCents: parsed.sellingPriceCents ?? null,
      notes: parsed.notes ?? null,
    },
    items: parsed.items.map((i) => ({ recipeId: i.recipeId, quantity: i.quantity })),
  };
}

export async function createMenuAction(
  input: unknown,
): Promise<ActionResult<Menu>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = menuSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const { fields, items } = toFieldsAndItems(parsed.data);

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await createMenu(tx, organizationId, fields, items);
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'menu.create',
      entityType: 'menu',
      entityId: result.menu.id,
      metadata: {
        itemCount: items.length,
        priceChanged: fields.sellingPriceCents !== null,
      },
    });
    return result.menu;
  });

  if (outcome === 'invalid_recipe') return { ok: false, code: 'MENU_RECIPE_INVALID' };
  revalidateMenus(outcome.id);
  return { ok: true, data: outcome };
}

export async function updateMenuAction(
  id: string,
  input: unknown,
): Promise<ActionResult<Menu>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = menuSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const { fields, items } = toFieldsAndItems(parsed.data);

  const outcome = await withOrg(organizationId, async (tx) => {
    // Snapshot the prior fields (for the non-sensitive change descriptor) before
    // the in-tx replace. A missing/trashed menu → not_found.
    const before = await getMenuById(tx, organizationId, id);
    if (!before) return 'not_found' as const;

    const result = await updateMenu(tx, organizationId, id, fields, items);
    if (result.status !== 'ok') return result.status;

    const changedFields: string[] = [];
    if (before.name !== fields.name) changedFields.push('name');
    if (before.sellingPriceCents !== fields.sellingPriceCents) {
      changedFields.push('sellingPrice');
    }
    if ((before.notes ?? null) !== fields.notes) changedFields.push('notes');

    await writeAuditEvent(tx, organizationId, actor, {
      action: 'menu.update',
      entityType: 'menu',
      entityId: id,
      metadata: {
        itemCount: items.length,
        priceChanged: before.sellingPriceCents !== fields.sellingPriceCents,
        changedFields,
      },
    });
    return result.menu;
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome === 'invalid_recipe') return { ok: false, code: 'MENU_RECIPE_INVALID' };
  revalidateMenus(id);
  return { ok: true, data: outcome };
}

/** Soft-delete (trash) an active menu — manager-only. */
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
