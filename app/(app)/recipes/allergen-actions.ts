'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  addOrEscalateRecipeOverride,
  clearRecipeOverride,
  loadRecipeAllergenRollup,
} from '@/lib/data/allergens';
import type { RecipeAllergenRollup } from '@/lib/calculations/allergens';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import {
  clearRecipeOverrideSchema,
  recipeOverrideSchema,
} from '@/lib/validation/allergens';
import type { ActionResult } from '@/lib/action-result';

/**
 * Server Actions for recipe-level allergen overrides (Sprint 9). OPERATIONAL —
 * kitchen MAY add/escalate/clear (no manager gate), every change AUDITED. RULE #1:
 * org id server-derived, validated input, guard + mutation + audit in one `withOrg`.
 *
 * Overrides may only ADD or ESCALATE; a downgrade/removal attempt returns
 * `ALLERGEN_CANNOT_DOWNGRADE`. Clearing an override never suppresses a derived
 * allergen (the effective recomputes to ≥ derived). Both return the fresh rollup so
 * the UI updates without a full reload.
 */

function revalidateRecipe(recipeId: string): void {
  revalidatePath('/recipes');
  revalidatePath(`/recipes/${recipeId}`);
}

export async function addRecipeOverrideAction(
  recipeId: string,
  input: unknown,
): Promise<ActionResult<RecipeAllergenRollup>> {
  const parsed = recipeOverrideSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await addOrEscalateRecipeOverride(
      tx,
      organizationId,
      recipeId,
      parsed.data.allergen,
      parsed.data.presence,
    );
    if (result.status !== 'done') return result;

    await writeAuditEvent(tx, organizationId, actor, {
      action: 'allergen.overrideAdd',
      entityType: 'recipe',
      entityId: recipeId,
      metadata: {
        allergen: result.allergen,
        before: result.before,
        after: result.after,
      },
    });
    const rollup = await loadRecipeAllergenRollup(tx, organizationId, recipeId);
    return { status: 'rollup' as const, rollup };
  });

  if (outcome.status === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome.status === 'cannot_downgrade') {
    return { ok: false, code: 'ALLERGEN_CANNOT_DOWNGRADE' };
  }
  revalidateRecipe(recipeId);
  return { ok: true, data: outcome.rollup };
}

export async function clearRecipeOverrideAction(
  recipeId: string,
  input: unknown,
): Promise<ActionResult<RecipeAllergenRollup>> {
  const parsed = clearRecipeOverrideSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await clearRecipeOverride(
      tx,
      organizationId,
      recipeId,
      parsed.data.allergen,
    );
    if (result.status === 'not_found') return result;

    await writeAuditEvent(tx, organizationId, actor, {
      action: 'allergen.overrideClear',
      entityType: 'recipe',
      entityId: recipeId,
      metadata: {
        allergen: result.allergen,
        removedPresence: result.removedPresence,
      },
    });
    const rollup = await loadRecipeAllergenRollup(tx, organizationId, recipeId);
    return { status: 'rollup' as const, rollup };
  });

  if (outcome.status === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  revalidateRecipe(recipeId);
  return { ok: true, data: outcome.rollup };
}
