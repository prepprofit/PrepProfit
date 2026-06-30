'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  addRecipePreset,
  removeRecipePreset,
  reorderRecipePresets,
  updateRecipePreset,
} from '@/lib/data/recipe-presets';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import {
  recipePresetSchema,
  reorderRecipePresetsSchema,
} from '@/lib/validation/recipe-presets';
import type { ActionResult } from '@/lib/action-result';
import type { RecipePreset } from '@/lib/db/schema';

/**
 * Server Actions for kitchen presets (Recipe-editor parity). Presets are
 * OPERATIONAL config (a named target finished weight) — BOTH manager and kitchen
 * manage name + weight, so there is NO manager gate and NO cost field is ever
 * accepted or returned. RULE #1: org id from Clerk on the server, every write
 * inside `withOrg` (RLS), Zod on all input. Canonical order per action:
 * Zod → getOrgId → auditActor → withOrg(mutation + audit in one tx) → revalidate.
 *
 * Audit metadata is the preset id + changed-field names + count ONLY — never the
 * preset name or weight value (presets drive printed prep output; CLAUDE.md keeps
 * names/values out of the trail).
 */

function revalidateRecipe(recipeId: string): void {
  revalidatePath('/recipes');
  revalidatePath(`/recipes/${recipeId}`);
}

export async function addRecipePresetAction(
  recipeId: string,
  input: unknown,
): Promise<ActionResult<RecipePreset>> {
  const parsed = recipePresetSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await addRecipePreset(tx, organizationId, recipeId, parsed.data);
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'recipePreset.create',
      entityType: 'recipePreset',
      entityId: result.row.id,
      metadata: { recipeId },
    });
    return result.row;
  });

  if (outcome === 'recipe_not_active') return { ok: false, code: 'NOT_FOUND' };
  if (outcome === 'duplicate') return { ok: false, code: 'DUPLICATE_NAME' };
  if (outcome === 'limit_reached') {
    return { ok: false, code: 'RECIPE_PRESET_LIMIT_REACHED' };
  }
  revalidateRecipe(recipeId);
  return { ok: true, data: outcome };
}

export async function updateRecipePresetAction(
  recipeId: string,
  presetId: string,
  input: unknown,
): Promise<ActionResult<RecipePreset>> {
  const parsed = recipePresetSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await updateRecipePreset(
      tx,
      organizationId,
      recipeId,
      presetId,
      parsed.data,
    );
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'recipePreset.update',
      entityType: 'recipePreset',
      entityId: presetId,
      // Both fields can change in one save; record WHICH fields, never the values.
      metadata: { recipeId, changedFields: ['name', 'targetWeightGrams'] },
    });
    return result.row;
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome === 'duplicate') return { ok: false, code: 'DUPLICATE_NAME' };
  revalidateRecipe(recipeId);
  return { ok: true, data: outcome };
}

export async function removeRecipePresetAction(
  recipeId: string,
  presetId: string,
): Promise<ActionResult> {
  const organizationId = await getOrgId();
  const actor = await auditActor();

  const removed = await withOrg(organizationId, async (tx) => {
    const ok = await removeRecipePreset(tx, organizationId, recipeId, presetId);
    if (!ok) return false;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'recipePreset.delete',
      entityType: 'recipePreset',
      entityId: presetId,
      metadata: { recipeId },
    });
    return true;
  });

  if (!removed) return { ok: false, code: 'NOT_FOUND' };
  revalidateRecipe(recipeId);
  return { ok: true, data: undefined };
}

/**
 * Reorders a recipe's presets. A stale set (concurrent add/remove, or a mismatched
 * payload) maps to RECIPE_PRESETS_CHANGED so the client can restore + ask the user
 * to reload; nothing is written/audited in that case.
 */
export async function reorderRecipePresetsAction(
  recipeId: string,
  input: unknown,
): Promise<ActionResult<{ count: number }>> {
  const parsed = reorderRecipePresetsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await reorderRecipePresets(
      tx,
      organizationId,
      recipeId,
      parsed.data.orderedPresetIds,
    );
    if (result.status !== 'ok') return result;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'recipePreset.reorder',
      entityType: 'recipe',
      entityId: recipeId,
      metadata: { recipeId, count: result.count },
    });
    return result;
  });

  if (outcome.status === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome.status === 'stale') {
    return { ok: false, code: 'RECIPE_PRESETS_CHANGED' };
  }
  revalidateRecipe(recipeId);
  return { ok: true, data: { count: outcome.count } };
}
