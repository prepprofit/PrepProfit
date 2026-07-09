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
  reorderRecipeIngredients,
  updateRecipeIngredient,
} from '@/lib/data/recipe-ingredients';
import {
  addRecipeComponent,
  countActiveParentsUsingComponent,
  listAncestorRecipeIds,
  lockRecipeComponentEndpoints,
  removeRecipeComponent,
  reorderRecipeComponents,
  updateRecipeComponent,
} from '@/lib/data/recipe-components';
import {
  kitchenRecipeSchema,
  recipeComponentSchema,
  recipeComponentUpdateSchema,
  recipeLineSchema,
  recipeLineUpdateSchema,
  recipeSchema,
  reorderRecipeComponentsSchema,
  reorderRecipeIngredientsSchema,
} from '@/lib/validation/recipes';
import type { ActionResult } from '@/lib/action-result';
import type { Recipe } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';

/**
 * Server Actions for the Recipes module. RULE #1: org id from Clerk on the
 * server, every write inside `withOrg` (RLS active), Zod validation on the server.
 */

function revalidateRecipe(id?: string): void {
  revalidatePath('/recipes');
  if (id) revalidatePath(`/recipes/${id}`);
}

/**
 * A component line change affects the parent AND every ancestor recipe, plus the
 * high-level surfaces that derive cost/allergens/explosion from the graph
 * (sub-recipes plan §UI). `ancestorIds` comes from the same transaction as the
 * write, so it can't miss a just-added parent.
 */
function revalidateRecipeGraph(recipeId: string, ancestorIds: string[]): void {
  revalidateRecipe(recipeId);
  for (const id of ancestorIds) revalidatePath(`/recipes/${id}`);
  revalidatePath('/dashboard');
  revalidatePath('/menus');
  revalidatePath('/productions');
  revalidatePath('/tasks/ai-prep-planner');
}

/** Map a data-layer component failure reason to its stable ActionErrorCode. */
function componentErrorCode(
  reason:
    | 'recipe_not_active'
    | 'component_invalid'
    | 'duplicate'
    | 'cycle'
    | 'depth_exceeded',
) {
  switch (reason) {
    case 'recipe_not_active':
      return 'NOT_FOUND' as const;
    case 'component_invalid':
      return 'RECIPE_COMPONENT_INVALID' as const;
    case 'duplicate':
      return 'RECIPE_COMPONENT_ALREADY_EXISTS' as const;
    case 'cycle':
      return 'RECIPE_CYCLE' as const;
    case 'depth_exceeded':
      return 'RECIPE_DEPTH_EXCEEDED' as const;
  }
}

/**
 * Sub-recipe component lines are OPERATIONAL like ingredient lines (locked
 * decision 8): both roles may add/update/remove/reorder them, no audit events
 * (decision 9), and the payloads carry no money. The graph invariants (active +
 * positive-yield component, no cycles, depth ≤ 5) are enforced in the data
 * layer under FOR UPDATE locks.
 */
export async function addRecipeComponentAction(
  recipeId: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const parsed = recipeComponentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await addRecipeComponent(tx, organizationId, recipeId, parsed.data);
    const ancestorIds = result.ok
      ? await listAncestorRecipeIds(tx, organizationId, recipeId)
      : [];
    return { result, ancestorIds };
  });
  if (!outcome.result.ok) {
    return { ok: false, code: componentErrorCode(outcome.result.reason) };
  }
  revalidateRecipeGraph(recipeId, outcome.ancestorIds);
  return { ok: true, data: { id: outcome.result.row.id } };
}

export async function updateRecipeComponentAction(
  recipeId: string,
  componentLineId: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = recipeComponentUpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const outcome = await withOrg(organizationId, async (tx) => {
    const row = await updateRecipeComponent(
      tx,
      organizationId,
      recipeId,
      componentLineId,
      parsed.data,
    );
    const ancestorIds = row
      ? await listAncestorRecipeIds(tx, organizationId, recipeId)
      : [];
    return { row, ancestorIds };
  });
  if (!outcome.row) return { ok: false, code: 'NOT_FOUND' };
  revalidateRecipeGraph(recipeId, outcome.ancestorIds);
  return { ok: true, data: undefined };
}

export async function removeRecipeComponentAction(
  recipeId: string,
  componentLineId: string,
): Promise<ActionResult> {
  const organizationId = await getOrgId();
  const outcome = await withOrg(organizationId, async (tx) => {
    const removed = await removeRecipeComponent(
      tx,
      organizationId,
      recipeId,
      componentLineId,
    );
    const ancestorIds = removed
      ? await listAncestorRecipeIds(tx, organizationId, recipeId)
      : [];
    return { removed, ancestorIds };
  });
  if (!outcome.removed) return { ok: false, code: 'NOT_FOUND' };
  revalidateRecipeGraph(recipeId, outcome.ancestorIds);
  return { ok: true, data: undefined };
}

export async function reorderRecipeComponentsAction(
  recipeId: string,
  input: unknown,
): Promise<ActionResult<{ count: number }>> {
  const parsed = reorderRecipeComponentsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const outcome = await withOrg(organizationId, (tx) =>
    reorderRecipeComponents(tx, organizationId, recipeId, parsed.data.orderedLineIds),
  );
  if (outcome.status === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome.status === 'stale') {
    return { ok: false, code: 'RECIPE_COMPONENTS_CHANGED' };
  }
  // Reorder is presentation-only — ancestors' derived data is unchanged.
  revalidateRecipe(recipeId);
  return { ok: true, data: { count: outcome.count } };
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

/**
 * Yield-clear guard (sub-recipes invariant): a recipe used as a component by an
 * ACTIVE parent must keep a positive `yieldWeightGrams` — component math divides
 * by it. Locks the recipe row (same lock as component-add) before counting.
 * Returns true when the update must be rejected.
 */
async function clearsYieldOfInUseComponent(
  tx: TenantClient,
  organizationId: string,
  recipeId: string,
  nextYieldWeightGrams: number | null | undefined,
): Promise<boolean> {
  if (nextYieldWeightGrams != null && nextYieldWeightGrams > 0) return false;
  await lockRecipeComponentEndpoints(tx, organizationId, [recipeId]);
  return (await countActiveParentsUsingComponent(tx, organizationId, recipeId)) > 0;
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
      if (
        await clearsYieldOfInUseComponent(
          tx,
          organizationId,
          id,
          parsed.data.yieldWeightGrams ?? null,
        )
      ) {
        return 'requires_yield' as const;
      }
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
    if (row === 'requires_yield') {
      return { ok: false, code: 'RECIPE_COMPONENT_REQUIRES_YIELD' };
    }
    if (!row) return { ok: false, code: 'NOT_FOUND' };
    revalidateRecipe(id);
    return { ok: true, data: toKitchenRecipe(row) };
  }

  // MANAGER: full edit including the money fields.
  const parsed = recipeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  const row = await withOrg(organizationId, async (tx) => {
    if (
      await clearsYieldOfInUseComponent(
        tx,
        organizationId,
        id,
        parsed.data.yieldWeightGrams ?? null,
      )
    ) {
      return 'requires_yield' as const;
    }
    return updateRecipe(tx, organizationId, id, parsed.data);
  });
  if (row === 'requires_yield') {
    return { ok: false, code: 'RECIPE_COMPONENT_REQUIRES_YIELD' };
  }
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  revalidateRecipe(id);
  return { ok: true, data: row };
}

/** Moves a recipe to the trash (soft-delete). Restorable for 30 days via /trash. */
export async function deleteRecipeAction(id: string): Promise<ActionResult> {
  const organizationId = await getOrgId();
  // A recipe used as a sub-recipe by an ACTIVE parent cannot be trashed — the
  // parent's cost/allergens/explosion would silently break. Lock the recipe row
  // first (the same lock component-add takes), so a concurrent add can't slip
  // its check between our count and the soft-delete.
  const outcome = await withOrg(organizationId, async (tx) => {
    await lockRecipeComponentEndpoints(tx, organizationId, [id]);
    if ((await countActiveParentsUsingComponent(tx, organizationId, id)) > 0) {
      return 'in_component' as const;
    }
    return softDeleteRecipe(tx, organizationId, id);
  });
  if (outcome === 'in_component') {
    return { ok: false, code: 'RECIPE_IN_COMPONENT' };
  }
  if (!outcome) return { ok: false, code: 'NOT_FOUND' };
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

/**
 * Reorders a recipe's ingredient lines (presentation/order metadata only — both
 * roles, no money, deliberately unaudited per the parity plan D6). A stale set
 * (concurrent add/remove, or a mismatched payload) maps to RECIPE_LINES_CHANGED so
 * the client can restore + ask the user to reload; nothing is written in that case.
 */
export async function reorderRecipeIngredientsAction(
  recipeId: string,
  input: unknown,
): Promise<ActionResult<{ count: number }>> {
  const parsed = reorderRecipeIngredientsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const outcome = await withOrg(organizationId, (tx) =>
    reorderRecipeIngredients(tx, organizationId, recipeId, parsed.data.orderedLineIds),
  );
  if (outcome.status === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome.status === 'stale') {
    return { ok: false, code: 'RECIPE_LINES_CHANGED' };
  }
  revalidateRecipe(recipeId);
  return { ok: true, data: { count: outcome.count } };
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
