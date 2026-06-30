'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { isUniqueViolation } from '@/lib/db/errors';
import { unexpected } from '@/lib/observability';
import { trackEvent } from '@/lib/analytics';
import {
  countActiveRecipes,
  createRecipe,
  getRecipeById,
  softDeleteRecipe,
  toKitchenRecipe,
  updateRecipe,
  type KitchenRecipe,
  type RecipeInput,
} from '@/lib/data/recipes';
import { assertPlanLimit } from '@/lib/entitlements';
import {
  addRecipeIngredient,
  removeRecipeIngredient,
  updateRecipeIngredient,
} from '@/lib/data/recipe-ingredients';
import {
  kitchenRecipeSchema,
  recipeLineSchema,
  recipeLineUpdateSchema,
  recipeSchema,
} from '@/lib/validation/recipes';
import type { ActionResult } from '@/lib/action-result';
import type { Recipe } from '@/lib/db/schema';

/**
 * Server Actions for the Recipes module. RULE #1: org id from Clerk on the
 * server, every write inside `withOrg` (RLS active), Zod validation on the server.
 */

function revalidateRecipe(id?: string): void {
  revalidatePath('/recipes');
  if (id) revalidatePath(`/recipes/${id}`);
}

export async function createRecipeAction(
  input: unknown,
): Promise<ActionResult<Recipe | KitchenRecipe>> {
  const organizationId = await getOrgId();
  const manager = await isManager();

  // KITCHEN: operational create only — the server forces all money fields to 0/null
  // so a forged cost/selling price can never land (Sprint F4, §2g.2). MANAGER: full.
  const parsedKitchen = manager ? null : kitchenRecipeSchema.safeParse(input);
  const parsedManager = manager ? recipeSchema.safeParse(input) : null;
  if (parsedKitchen && !parsedKitchen.success) {
    return { ok: false, code: 'INVALID_INPUT' };
  }
  if (parsedManager && !parsedManager.success) {
    return { ok: false, code: 'INVALID_INPUT' };
  }
  const values: RecipeInput =
    parsedManager?.success
      ? parsedManager.data
      : {
          name: parsedKitchen!.data.name,
          folderId: parsedKitchen!.data.folderId ?? null,
          yieldPortions: parsedKitchen!.data.yieldPortions,
          yieldPercentage: parsedKitchen!.data.yieldPercentage,
          // Operational physical data — kitchen sets the batch weight, never money.
          yieldWeightGrams: parsedKitchen!.data.yieldWeightGrams ?? null,
          laborCostCents: 0,
          energyCostCents: 0,
          packagingCostCents: 0,
          sellingPriceCents: null,
          notes: parsedKitchen!.data.notes ?? null,
        };

  // Plan recipe cap (Sprint 4): count + cap check + insert share one withOrg
  // transaction so the Starter limit can't be raced past. `null` = cap reached.
  const row = await withOrg(organizationId, async (tx) => {
    const current = await countActiveRecipes(tx, organizationId);
    const { allowed } = await assertPlanLimit('recipes', current);
    if (!allowed) return null;
    return createRecipe(tx, organizationId, values);
  });
  if (!row) return { ok: false, code: 'PLAN_LIMIT_REACHED' };
  revalidateRecipe(row.id);
  // Product analytics (Sprint 5c): post-success, PII-free, best-effort.
  await trackEvent({
    event: 'recipe_created',
    orgId: organizationId,
    properties: { hasFolder: row.folderId !== null },
  });
  return { ok: true, data: manager ? row : toKitchenRecipe(row) };
}

export async function updateRecipeAction(
  id: string,
  input: unknown,
): Promise<ActionResult<Recipe | KitchenRecipe>> {
  const organizationId = await getOrgId();

  // KITCHEN: edits ONLY operational fields; the stored money is preserved and never
  // received from the client (Sprint F4, decision #3). The action merges onto the
  // current row server-side, so kitchen never has to echo a hidden cost/price.
  if (!(await isManager())) {
    const parsed = kitchenRecipeSchema.safeParse(input);
    if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
    const row = await withOrg(organizationId, async (tx) => {
      const current = await getRecipeById(tx, organizationId, id);
      if (!current) return null;
      return updateRecipe(tx, organizationId, id, {
        name: parsed.data.name,
        folderId: parsed.data.folderId ?? null,
        yieldPortions: parsed.data.yieldPortions,
        yieldPercentage: parsed.data.yieldPercentage,
        // Operational physical data — kitchen sets the batch weight, never money.
        yieldWeightGrams: parsed.data.yieldWeightGrams ?? null,
        // Preserve all money verbatim — a kitchen edit is non-financial.
        laborCostCents: current.laborCostCents,
        energyCostCents: current.energyCostCents,
        packagingCostCents: current.packagingCostCents,
        sellingPriceCents: current.sellingPriceCents,
        notes: parsed.data.notes ?? null,
      });
    });
    if (!row) return { ok: false, code: 'NOT_FOUND' };
    revalidateRecipe(id);
    return { ok: true, data: toKitchenRecipe(row) };
  }

  // MANAGER: full edit including the money fields.
  const parsed = recipeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  const row = await withOrg(organizationId, (tx) =>
    updateRecipe(tx, organizationId, id, parsed.data),
  );
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  revalidateRecipe(id);
  return { ok: true, data: row };
}

/** Moves a recipe to the trash (soft-delete). Restorable for 30 days via /trash. */
export async function deleteRecipeAction(id: string): Promise<ActionResult> {
  const organizationId = await getOrgId();
  const row = await withOrg(organizationId, (tx) =>
    softDeleteRecipe(tx, organizationId, id),
  );
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  revalidateRecipe();
  revalidatePath('/dashboard');
  revalidatePath('/trash');
  return { ok: true, data: undefined };
}

export async function addRecipeIngredientAction(
  recipeId: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const parsed = recipeLineSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  try {
    const result = await withOrg(organizationId, (tx) =>
      addRecipeIngredient(tx, organizationId, { recipeId, ...parsed.data }),
    );
    if (!result.ok) {
      return {
        ok: false,
        code:
          result.reason === 'recipe_not_active'
            ? 'NOT_FOUND'
            : 'RECIPE_HAS_TRASHED_INGREDIENTS',
      };
    }
    revalidateRecipe(recipeId);
    return { ok: true, data: { id: result.row.id } };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, code: 'ALREADY_IN_RECIPE' };
    }
    return unexpected('addRecipeIngredientAction', err, organizationId);
  }
}

export async function updateRecipeIngredientAction(
  recipeId: string,
  lineId: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = recipeLineUpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const row = await withOrg(organizationId, (tx) =>
    updateRecipeIngredient(tx, organizationId, recipeId, lineId, parsed.data),
  );
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  revalidateRecipe(recipeId);
  return { ok: true, data: undefined };
}

export async function removeRecipeIngredientAction(
  recipeId: string,
  lineId: string,
): Promise<ActionResult> {
  const organizationId = await getOrgId();
  const removed = await withOrg(organizationId, (tx) =>
    removeRecipeIngredient(tx, organizationId, recipeId, lineId),
  );
  if (!removed) return { ok: false, code: 'NOT_FOUND' };
  revalidateRecipe(recipeId);
  return { ok: true, data: undefined };
}
