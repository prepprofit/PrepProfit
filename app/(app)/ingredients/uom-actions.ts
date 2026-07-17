'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { unexpected } from '@/lib/observability';
import { auditActor } from '@/lib/data/audit';
import {
  createPrepAction,
  deleteIngredientEquivalency,
  deletePrepAction,
  updatePrepAction,
  upsertIngredientEquivalency,
} from '@/lib/data/ingredient-uom';
import {
  createPrepActionSchema,
  deleteEquivalencySchema,
  deletePrepActionSchema,
  updatePrepActionSchema,
  upsertEquivalencySchema,
} from '@/lib/validation/ingredient-uom';
import type { IngredientPrepAction, IngredientUomEquivalency } from '@/lib/db/schema';
import type { ActionResult } from '@/lib/action-result';

/**
 * Server Actions for UoM equivalencies + prep actions (Recipes 2.0 Fase 4).
 * OPERATIONAL, money-free — both roles may edit (like allergens/structure),
 * so no manager gate and no audit (not a high-risk surface). RULE #1: org id
 * server-derived, Zod first, all writes inside `withOrg`.
 */

function revalidateUomSurfaces(): void {
  revalidatePath('/ingredients');
  revalidatePath('/recipes');
}

export async function upsertEquivalencyAction(
  input: unknown,
): Promise<ActionResult<{ equivalency: IngredientUomEquivalency }>> {
  const parsed = upsertEquivalencySchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  try {
    const organizationId = await getOrgId();
    const actor = await auditActor();
    const result = await withOrg(organizationId, (tx) =>
      upsertIngredientEquivalency(
        tx,
        organizationId,
        parsed.data.ingredientId,
        parsed.data,
        actor.userId,
      ),
    );
    if (result.status === 'not_found') return { ok: false, code: 'NOT_FOUND' };
    if (result.status === 'invalid_anchors') return { ok: false, code: 'INVALID_INPUT' };
    revalidateUomSurfaces();
    return { ok: true, data: { equivalency: result.equivalency } };
  } catch (error) {
    return unexpected('upsertEquivalencyAction', error);
  }
}

export async function deleteEquivalencyAction(
  input: unknown,
): Promise<ActionResult<Record<string, never>>> {
  const parsed = deleteEquivalencySchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  try {
    const organizationId = await getOrgId();
    const result = await withOrg(organizationId, (tx) =>
      deleteIngredientEquivalency(tx, organizationId, parsed.data.ingredientId),
    );
    if (result === 'not_found') return { ok: false, code: 'NOT_FOUND' };
    revalidateUomSurfaces();
    return { ok: true, data: {} };
  } catch (error) {
    return unexpected('deleteEquivalencyAction', error);
  }
}

export async function createPrepActionAction(
  input: unknown,
): Promise<ActionResult<{ prepAction: IngredientPrepAction }>> {
  const parsed = createPrepActionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  try {
    const organizationId = await getOrgId();
    const result = await withOrg(organizationId, (tx) =>
      createPrepAction(tx, organizationId, parsed.data.ingredientId, parsed.data),
    );
    if (result.status === 'not_found') return { ok: false, code: 'NOT_FOUND' };
    if (result.status === 'duplicate_name') {
      return { ok: false, code: 'DUPLICATE_NAME' };
    }
    revalidateUomSurfaces();
    return { ok: true, data: { prepAction: result.prepAction } };
  } catch (error) {
    return unexpected('createPrepActionAction', error);
  }
}

export async function updatePrepActionAction(
  input: unknown,
): Promise<ActionResult<{ prepAction: IngredientPrepAction }>> {
  const parsed = updatePrepActionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  try {
    const organizationId = await getOrgId();
    const result = await withOrg(organizationId, (tx) =>
      updatePrepAction(tx, organizationId, parsed.data.prepActionId, parsed.data),
    );
    if (result.status === 'not_found') return { ok: false, code: 'NOT_FOUND' };
    if (result.status === 'duplicate_name') {
      return { ok: false, code: 'DUPLICATE_NAME' };
    }
    revalidateUomSurfaces();
    return { ok: true, data: { prepAction: result.prepAction } };
  } catch (error) {
    return unexpected('updatePrepActionAction', error);
  }
}

export async function deletePrepActionAction(
  input: unknown,
): Promise<ActionResult<Record<string, never>>> {
  const parsed = deletePrepActionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  try {
    const organizationId = await getOrgId();
    const result = await withOrg(organizationId, (tx) =>
      deletePrepAction(tx, organizationId, parsed.data.prepActionId),
    );
    if (result === 'not_found') return { ok: false, code: 'NOT_FOUND' };
    if (result === 'in_use') return { ok: false, code: 'PREP_ACTION_IN_USE' };
    revalidateUomSurfaces();
    return { ok: true, data: {} };
  } catch (error) {
    return unexpected('deletePrepActionAction', error);
  }
}
