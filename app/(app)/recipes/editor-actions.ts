'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { recipeFolders, recipes } from '@/lib/db/schema';
import { isForeignKeyViolation } from '@/lib/db/errors';
import { unexpected } from '@/lib/observability';
import { trackEvent } from '@/lib/analytics';
import { assertPlanLimit } from '@/lib/entitlements';
import { auditActor, writeAuditEvent, type AuditActor } from '@/lib/data/audit';
import { countActiveRecipes, createRecipe, moveRecipeToFolder } from '@/lib/data/recipes';
import { saveRecipeWorkspace, type SaveRecipeWorkspaceResult } from '@/lib/data/recipe-workspace';
import { listAncestorRecipeIds } from '@/lib/data/recipe-components';
import { syncRecipePresets, type SyncRecipePresetsOutcome } from '@/lib/data/recipe-presets';
import { recipeEditorCreateSchema, recipeEditorUpdateSchema } from '@/lib/validation/recipe-editor';
import type { TenantClient } from '@/lib/db/tenant';
import type { ActionErrorCode, ActionResult } from '@/lib/action-result';

/**
 * Server Actions behind the recipe editor (`/recipes/new`, `/recipes/[id]/edit`).
 * The whole form saves in ONE `withOrg` transaction — recipe row, ingredient lines,
 * method/notes, finished weight, folder, display unit and kitchen presets — so a
 * failure anywhere rolls everything back. In particular a new recipe only exists
 * once "Save recipe" succeeds: cancelling the editor never leaves an empty record.
 *
 * Both roles may call these: the payload is operational only (Zod strips any money
 * field, and a new recipe's money columns are forced to 0/null). RULE #1: org id
 * from Clerk, every read/write org-scoped inside `withOrg`, Zod on the server.
 */

/** Thrown inside the transaction to roll it back with a stable action error. */
class EditorSaveAbort extends Error {
  constructor(readonly code: ActionErrorCode) {
    super(code);
  }
}

function workspaceFailure(result: Exclude<SaveRecipeWorkspaceResult, { ok: true }>): ActionErrorCode {
  if (result.reason === 'not_found') return 'NOT_FOUND';
  if (result.reason === 'version_conflict') return 'WORKSPACE_VERSION_CONFLICT';
  if (result.detail === 'component_cycle') return 'RECIPE_CYCLE';
  if (result.detail === 'component_invalid') return 'RECIPE_COMPONENT_INVALID';
  return 'WORKSPACE_DRAFT_INVALID';
}

function presetFailure(outcome: Exclude<SyncRecipePresetsOutcome, { status: 'ok' }>): ActionErrorCode {
  if (outcome.status === 'duplicate') return 'DUPLICATE_NAME';
  if (outcome.status === 'limit_reached') return 'RECIPE_PRESET_LIMIT_REACHED';
  return 'RECIPE_PRESETS_CHANGED';
}

async function assertFolderExists(tx: TenantClient, organizationId: string, folderId: string | null) {
  if (folderId === null) return;
  const [folder] = await tx
    .select({ id: recipeFolders.id })
    .from(recipeFolders)
    .where(and(eq(recipeFolders.organizationId, organizationId), eq(recipeFolders.id, folderId)))
    .limit(1);
  if (!folder) throw new EditorSaveAbort('NOT_FOUND');
}

async function savePresets(
  tx: TenantClient,
  organizationId: string,
  recipeId: string,
  presets: { id?: string; name: string; targetWeightGrams: number }[],
  actor: AuditActor,
) {
  const outcome = await syncRecipePresets(tx, organizationId, recipeId, presets);
  if (outcome.status !== 'ok') throw new EditorSaveAbort(presetFailure(outcome));
  if (outcome.added + outcome.updated + outcome.removed > 0) {
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'recipePreset.sync',
      entityType: 'recipe',
      entityId: recipeId,
      metadata: { added: outcome.added, updated: outcome.updated, removed: outcome.removed },
    });
  }
}

function revalidateRecipeSurfaces(recipeId: string, ancestorIds: string[] = []) {
  revalidatePath('/recipes');
  revalidatePath(`/recipes/${recipeId}`);
  for (const id of ancestorIds) revalidatePath(`/recipes/${id}`);
  revalidatePath('/kitchen-scale');
  revalidatePath('/dashboard');
  revalidatePath('/menus');
  revalidatePath('/productions');
}

function failure(error: unknown, action: string): ActionResult<never> {
  if (error instanceof EditorSaveAbort) return { ok: false, code: error.code };
  // The composite FK rejects a folder or component that vanished mid-save.
  if (isForeignKeyViolation(error)) return { ok: false, code: 'NOT_FOUND' };
  return unexpected(action, error);
}

/** Creates the recipe from the editor in one go. The recipe exists only if this succeeds. */
export async function createRecipeFromEditorAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const parsed = recipeEditorCreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  const data = parsed.data;

  try {
    const organizationId = await getOrgId();
    const actor = await auditActor();
    const created = await withOrg(organizationId, async (tx) => {
      // Plan recipe cap: count + check + insert share this transaction.
      const current = await countActiveRecipes(tx, organizationId);
      const { allowed } = await assertPlanLimit('recipes', current);
      if (!allowed) throw new EditorSaveAbort('PLAN_LIMIT_REACHED');
      await assertFolderExists(tx, organizationId, data.folderId);

      const row = await createRecipe(tx, organizationId, {
        name: data.name,
        folderId: data.folderId,
        yieldPortions: 1,
        yieldPercentage: data.yield.percentage,
        laborCostCents: 0,
        energyCostCents: 0,
        packagingCostCents: 0,
        sellingPriceCents: null,
        notes: data.notes,
        displayUnit: data.displayUnit,
      });
      const saved = await saveRecipeWorkspace(
        tx,
        organizationId,
        row.id,
        row.version,
        { header: { yield: data.yield }, sections: [], lines: data.lines },
        actor,
      );
      if (!saved.ok) throw new EditorSaveAbort(workspaceFailure(saved));
      await savePresets(tx, organizationId, row.id, data.presets, actor);
      return { id: row.id, hasFolder: row.folderId !== null };
    });

    revalidateRecipeSurfaces(created.id);
    await trackEvent({
      event: 'recipe_created',
      orgId: organizationId,
      properties: { hasFolder: created.hasFolder },
    });
    return { ok: true, data: { id: created.id } };
  } catch (error) {
    return failure(error, 'createRecipeFromEditorAction');
  }
}

/** Saves an existing recipe from the editor (optimistic concurrency on its version). */
export async function saveRecipeEditorAction(
  input: unknown,
): Promise<ActionResult<{ version: number }>> {
  const parsed = recipeEditorUpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  const data = parsed.data;

  try {
    const organizationId = await getOrgId();
    const actor = await auditActor();
    const { version, ancestorIds } = await withOrg(organizationId, async (tx) => {
      const saved = await saveRecipeWorkspace(
        tx,
        organizationId,
        data.recipeId,
        data.expectedVersion,
        {
          header: {
            name: data.name,
            notes: data.notes,
            displayUnit: data.displayUnit,
            coverMediaId: data.coverMediaId,
            yield: data.yield,
          },
          sections: data.sections,
          lines: data.lines,
          methodSections: data.methodSections,
          steps: data.steps,
        },
        actor,
      );
      if (!saved.ok) throw new EditorSaveAbort(workspaceFailure(saved));

      const [current] = await tx
        .select({ folderId: recipes.folderId })
        .from(recipes)
        .where(and(eq(recipes.organizationId, organizationId), eq(recipes.id, data.recipeId)))
        .limit(1);
      if ((current?.folderId ?? null) !== data.folderId) {
        await assertFolderExists(tx, organizationId, data.folderId);
        const moved = await moveRecipeToFolder(tx, organizationId, data.recipeId, data.folderId);
        if (!moved) throw new EditorSaveAbort('NOT_FOUND');
      }

      await savePresets(tx, organizationId, data.recipeId, data.presets, actor);
      // Lines may change sub-recipe links → ancestors' cost/allergens change too.
      const ancestors = await listAncestorRecipeIds(tx, organizationId, data.recipeId);
      return { version: saved.version, ancestorIds: ancestors };
    });

    revalidateRecipeSurfaces(data.recipeId, ancestorIds);
    return { ok: true, data: { version } };
  } catch (error) {
    return failure(error, 'saveRecipeEditorAction');
  }
}
