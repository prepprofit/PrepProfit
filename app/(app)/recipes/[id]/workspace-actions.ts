'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { unexpected } from '@/lib/observability';
import { auditActor } from '@/lib/data/audit';
import {
  saveRecipeWorkspace,
  type SaveRecipeWorkspaceResult,
} from '@/lib/data/recipe-workspace';
import { listAncestorRecipeIds } from '@/lib/data/recipe-components';
import { workspaceSaveSchema } from '@/lib/validation/recipe-workspace';
import type { ActionResult } from '@/lib/action-result';

/**
 * Recipes 2.0 workspace save (plan §10). ONE action persists the whole edit
 * draft atomically through the facade. Both roles may call it — the draft
 * carries only OPERATIONAL data (structure, quantities, notes, yield); money
 * never flows through here, so kitchen edits are as safe as the legacy
 * operational actions. RULE #1: org id from Clerk, write inside `withOrg`,
 * Zod on the server.
 */
export async function saveWorkspaceAction(
  input: unknown,
): Promise<ActionResult<{ version: number }>> {
  const parsed = workspaceSaveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  const {
    recipeId,
    expectedVersion,
    header,
    sections,
    lines,
    methodSections,
    steps,
  } = parsed.data;

  try {
    const organizationId = await getOrgId();
    const actor = await auditActor();

    const { result, ancestorIds } = await withOrg(
      organizationId,
      async (tx) => {
        const saveResult: SaveRecipeWorkspaceResult =
          await saveRecipeWorkspace(
            tx,
            organizationId,
            recipeId,
            expectedVersion,
            { header, sections, lines, methodSections, steps },
            actor,
          );
        // Structure may change component lines → ancestors' derived cost/
        // allergens change too. Collect inside the same transaction.
        const ancestors = saveResult.ok
          ? await listAncestorRecipeIds(tx, organizationId, recipeId)
          : [];
        return { result: saveResult, ancestorIds: ancestors };
      },
    );

    if (!result.ok) {
      if (result.reason === 'not_found') return { ok: false, code: 'NOT_FOUND' };
      if (result.reason === 'version_conflict') {
        return { ok: false, code: 'WORKSPACE_VERSION_CONFLICT' };
      }
      return { ok: false, code: 'WORKSPACE_DRAFT_INVALID' };
    }

    revalidatePath('/recipes');
    revalidatePath(`/recipes/${recipeId}`);
    for (const id of ancestorIds) revalidatePath(`/recipes/${id}`);
    revalidatePath('/dashboard');
    revalidatePath('/menus');
    revalidatePath('/productions');

    return { ok: true, data: { version: result.version } };
  } catch (error) {
    return unexpected('saveWorkspaceAction', error);
  }
}
