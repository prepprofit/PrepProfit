'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { isUniqueViolation } from '@/lib/db/errors';
import {
  createRecipe,
  softDeleteRecipe,
  updateRecipe,
} from '@/lib/data/recipes';
import {
  addRecipeIngredient,
  removeRecipeIngredient,
  updateRecipeIngredient,
} from '@/lib/data/recipe-ingredients';
import {
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
): Promise<ActionResult<Recipe>> {
  const parsed = recipeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid recipe data.' };

  const organizationId = await getOrgId();
  const row = await withOrg(organizationId, (tx) =>
    createRecipe(tx, organizationId, parsed.data),
  );
  revalidateRecipe(row.id);
  return { ok: true, data: row };
}

export async function updateRecipeAction(
  id: string,
  input: unknown,
): Promise<ActionResult<Recipe>> {
  const parsed = recipeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid recipe data.' };

  const organizationId = await getOrgId();
  const row = await withOrg(organizationId, (tx) =>
    updateRecipe(tx, organizationId, id, parsed.data),
  );
  if (!row) return { ok: false, error: 'Recipe not found.' };
  revalidateRecipe(id);
  return { ok: true, data: row };
}

/** Moves a recipe to the trash (soft-delete). Restorable for 30 days via /trash. */
export async function deleteRecipeAction(id: string): Promise<ActionResult> {
  const organizationId = await getOrgId();
  const row = await withOrg(organizationId, (tx) =>
    softDeleteRecipe(tx, organizationId, id),
  );
  if (!row) return { ok: false, error: 'Recipe not found.' };
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
  if (!parsed.success) return { ok: false, error: 'Invalid recipe line.' };

  const organizationId = await getOrgId();
  try {
    const row = await withOrg(organizationId, (tx) =>
      addRecipeIngredient(tx, organizationId, { recipeId, ...parsed.data }),
    );
    revalidateRecipe(recipeId);
    return { ok: true, data: { id: row.id } };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, error: 'That ingredient is already in this recipe.' };
    }
    throw err;
  }
}

export async function updateRecipeIngredientAction(
  recipeId: string,
  lineId: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = recipeLineUpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid recipe line.' };

  const organizationId = await getOrgId();
  const row = await withOrg(organizationId, (tx) =>
    updateRecipeIngredient(tx, organizationId, lineId, parsed.data),
  );
  if (!row) return { ok: false, error: 'Recipe line not found.' };
  revalidateRecipe(recipeId);
  return { ok: true, data: undefined };
}

export async function removeRecipeIngredientAction(
  recipeId: string,
  lineId: string,
): Promise<ActionResult> {
  const organizationId = await getOrgId();
  await withOrg(organizationId, (tx) =>
    removeRecipeIngredient(tx, organizationId, lineId),
  );
  revalidateRecipe(recipeId);
  return { ok: true, data: undefined };
}
