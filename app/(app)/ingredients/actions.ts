'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  countActiveRecipesUsingIngredient,
  createIngredient,
  softDeleteIngredient,
  updateIngredient,
} from '@/lib/data/ingredients';
import { ingredientSchema } from '@/lib/validation/ingredients';
import type { ActionResult } from '@/lib/action-result';
import type { Ingredient } from '@/lib/db/schema';

/**
 * Server Actions for the Ingredients module. RULE #1: the org id is derived from
 * Clerk on the server (never the client), every write runs inside `withOrg` so
 * RLS is active, and all input is validated with Zod on the server.
 */

/** Recipe cost is derived from ingredient prices, so refresh recipes too. */
function revalidateIngredientConsumers(): void {
  revalidatePath('/ingredients');
  revalidatePath('/recipes');
}

export async function createIngredientAction(
  input: unknown,
): Promise<ActionResult<Ingredient>> {
  const parsed = ingredientSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid ingredient data.' };

  const organizationId = await getOrgId();
  const row = await withOrg(organizationId, (tx) =>
    createIngredient(tx, organizationId, parsed.data),
  );
  revalidateIngredientConsumers();
  return { ok: true, data: row };
}

export async function updateIngredientAction(
  id: string,
  input: unknown,
): Promise<ActionResult<Ingredient>> {
  const parsed = ingredientSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid ingredient data.' };

  const organizationId = await getOrgId();
  const row = await withOrg(organizationId, (tx) =>
    updateIngredient(tx, organizationId, id, parsed.data),
  );
  if (!row) return { ok: false, error: 'Ingredient not found.' };
  revalidateIngredientConsumers();
  return { ok: true, data: row };
}

/**
 * Moves an ingredient to the trash (soft-delete). Blocked if any ACTIVE recipe
 * still uses it — the in-use check and the soft-delete run in one transaction so
 * a recipe cannot start using it between the two. Restorable for 30 days via /trash.
 */
export async function deleteIngredientAction(
  id: string,
): Promise<ActionResult> {
  const organizationId = await getOrgId();
  const outcome = await withOrg(organizationId, async (tx) => {
    const inUse = await countActiveRecipesUsingIngredient(tx, organizationId, id);
    if (inUse > 0) return { status: 'in_use' as const, inUse };
    const row = await softDeleteIngredient(tx, organizationId, id);
    return { status: row ? ('done' as const) : ('not_found' as const) };
  });

  if (outcome.status === 'in_use') {
    return {
      ok: false,
      error:
        "This ingredient is used by an active recipe, so it can't be moved to the trash. Remove it from those recipes first.",
    };
  }
  if (outcome.status === 'not_found') {
    return { ok: false, error: 'Ingredient not found.' };
  }
  revalidateIngredientConsumers();
  revalidatePath('/trash');
  return { ok: true, data: undefined };
}
