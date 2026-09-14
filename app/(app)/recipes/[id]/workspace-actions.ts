'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getOrgId, isManager } from '@/lib/auth';
import { recipes } from '@/lib/db/schema';
import { withOrg } from '@/lib/db';
import { unexpected } from '@/lib/observability';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import {
  saveRecipeWorkspace,
  type SaveRecipeWorkspaceResult,
} from '@/lib/data/recipe-workspace';
import { listAncestorRecipeIds } from '@/lib/data/recipe-components';
import { workspaceSaveSchema } from '@/lib/validation/recipe-workspace';
import type { ActionResult } from '@/lib/action-result';

const legacyCostsSchema = z
  .object({ labour: z.boolean(), energy: z.boolean() })
  .refine((v) => v.labour || v.energy);

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

/**
 * Remove labour and/or energy amounts that the retired recipe editor saved. Labour
 * and energy are entered in Menu now; until removed here they stay inside the recipe's
 * batch cost (shown for review, never hidden or counted twice). MANAGER-ONLY and
 * audited; it touches only these two amounts.
 */
export async function clearLegacyRecipeCostsAction(
  recipeId: string,
  input: unknown,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = legacyCostsSchema.safeParse(input);
  if (!parsed.success || typeof recipeId !== 'string' || recipeId.trim() === '') {
    return { ok: false, code: 'INVALID_INPUT' };
  }
  try {
    const organizationId = await getOrgId();
    const actor = await auditActor();
    const outcome = await withOrg(organizationId, async (tx) => {
      const [before] = await tx
        .select({ labour: recipes.laborCostCents, energy: recipes.energyCostCents })
        .from(recipes)
        .where(and(eq(recipes.organizationId, organizationId), eq(recipes.id, recipeId), isNull(recipes.deletedAt)))
        .limit(1);
      if (!before) return 'not_found' as const;
      await tx
        .update(recipes)
        .set({
          ...(parsed.data.labour ? { laborCostCents: 0 } : {}),
          ...(parsed.data.energy ? { energyCostCents: 0 } : {}),
        })
        .where(and(eq(recipes.organizationId, organizationId), eq(recipes.id, recipeId)));
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'recipe.legacyCostsCleared',
        entityType: 'recipe',
        entityId: recipeId,
        metadata: {
          labourClearedCents: parsed.data.labour ? before.labour : 0,
          energyClearedCents: parsed.data.energy ? before.energy : 0,
        },
      });
      return 'ok' as const;
    });
    if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
    revalidatePath('/recipes');
    revalidatePath(`/recipes/${recipeId}`);
    revalidatePath('/menus');
    return { ok: true, data: undefined };
  } catch (error) {
    return unexpected('clearLegacyRecipeCostsAction', error);
  }
}
