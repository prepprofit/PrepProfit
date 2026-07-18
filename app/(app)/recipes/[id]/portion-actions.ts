'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { unexpected } from '@/lib/observability';
import { auditActor } from '@/lib/data/audit';
import {
  createPortionOption,
  deletePortionOption,
  setDefaultPortionOption,
  setNutritionServingPortionOption,
  updatePortionOption,
} from '@/lib/data/recipe-portion-options';
import {
  createPortionOptionSchema,
  portionOptionIdSchema,
  updatePortionOptionSchema,
} from '@/lib/validation/recipe-portion-options';
import type { RecipePortionOption } from '@/lib/db/schema';
import type { ActionResult } from '@/lib/action-result';

/**
 * Server Actions for portion options (Recipes 2.0 Fase 5, §6.8). FINANCIAL —
 * selling prices and food-cost targets — so every action is MANAGER-ONLY
 * (`FORBIDDEN` before any data access) and audited inside the mutation's
 * `withOrg` transaction. RULE #1: org id server-derived, Zod first.
 */

function revalidatePortionSurfaces(recipeId: string): void {
  revalidatePath(`/recipes/${recipeId}`);
  revalidatePath('/recipes');
  revalidatePath('/menus');
  revalidatePath('/dashboard');
}

export async function createPortionOptionAction(
  input: unknown,
): Promise<ActionResult<{ option: RecipePortionOption }>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = createPortionOptionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  try {
    const organizationId = await getOrgId();
    const actor = await auditActor();
    const result = await withOrg(organizationId, (tx) =>
      createPortionOption(tx, organizationId, parsed.data.recipeId, parsed.data, actor),
    );
    if (result.status === 'not_found') return { ok: false, code: 'NOT_FOUND' };
    if (result.status === 'limit_reached') {
      return { ok: false, code: 'PORTION_OPTION_LIMIT_REACHED' };
    }
    revalidatePortionSurfaces(parsed.data.recipeId);
    return { ok: true, data: { option: result.option } };
  } catch (error) {
    return unexpected('createPortionOptionAction', error);
  }
}

export async function updatePortionOptionAction(
  input: unknown,
): Promise<ActionResult<{ option: RecipePortionOption }>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = updatePortionOptionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  try {
    const organizationId = await getOrgId();
    const actor = await auditActor();
    const result = await withOrg(organizationId, (tx) =>
      updatePortionOption(tx, organizationId, parsed.data.optionId, parsed.data, actor),
    );
    if (result.status !== 'done') return { ok: false, code: 'NOT_FOUND' };
    revalidatePortionSurfaces(result.option.recipeId);
    return { ok: true, data: { option: result.option } };
  } catch (error) {
    return unexpected('updatePortionOptionAction', error);
  }
}

export async function deletePortionOptionAction(
  input: unknown,
): Promise<ActionResult<Record<string, never>>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = portionOptionIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  try {
    const organizationId = await getOrgId();
    const actor = await auditActor();
    const result = await withOrg(organizationId, (tx) =>
      deletePortionOption(tx, organizationId, parsed.data.optionId, actor),
    );
    if (result === 'not_found') return { ok: false, code: 'NOT_FOUND' };
    revalidatePath('/recipes');
    revalidatePath('/menus');
    revalidatePath('/dashboard');
    return { ok: true, data: {} };
  } catch (error) {
    return unexpected('deletePortionOptionAction', error);
  }
}

export async function setDefaultPortionOptionAction(
  input: unknown,
): Promise<ActionResult<{ option: RecipePortionOption }>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = portionOptionIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  try {
    const organizationId = await getOrgId();
    const actor = await auditActor();
    const result = await withOrg(organizationId, (tx) =>
      setDefaultPortionOption(tx, organizationId, parsed.data.optionId, actor),
    );
    if (result.status !== 'done') return { ok: false, code: 'NOT_FOUND' };
    revalidatePortionSurfaces(result.option.recipeId);
    return { ok: true, data: { option: result.option } };
  } catch (error) {
    return unexpected('setDefaultPortionOptionAction', error);
  }
}

export async function setNutritionServingPortionOptionAction(
  input: unknown,
): Promise<ActionResult<{ option: RecipePortionOption }>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = portionOptionIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  try {
    const organizationId = await getOrgId();
    const actor = await auditActor();
    const result = await withOrg(organizationId, (tx) =>
      setNutritionServingPortionOption(tx, organizationId, parsed.data.optionId, actor),
    );
    if (result.status !== 'done') return { ok: false, code: 'NOT_FOUND' };
    revalidatePortionSurfaces(result.option.recipeId);
    return { ok: true, data: { option: result.option } };
  } catch (error) {
    return unexpected('setNutritionServingPortionOptionAction', error);
  }
}
