'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { isForeignKeyViolation } from '@/lib/db/errors';
import { purgeIngredient, restoreIngredient } from '@/lib/data/ingredients';
import {
  countTrashedIngredientsInRecipe,
  purgeRecipe,
  restoreRecipe,
} from '@/lib/data/recipes';
import type { ActionResult } from '@/lib/action-result';

/**
 * Server Actions for the trash. RULE #1: org id from Clerk on the server, every
 * write inside `withOrg` (RLS active). Restore/purge are per-org operations, so
 * they need no RLS carve-out (unlike the cross-org auto-purge cron).
 */

function revalidateTrash(): void {
  revalidatePath('/trash');
  revalidatePath('/recipes');
  revalidatePath('/ingredients');
  revalidatePath('/dashboard');
}

export async function restoreRecipeAction(id: string): Promise<ActionResult> {
  const organizationId = await getOrgId();
  // Block + restore in one transaction so the guard can't be raced.
  const outcome = await withOrg(organizationId, async (tx) => {
    const trashedIngredients = await countTrashedIngredientsInRecipe(
      tx,
      organizationId,
      id,
    );
    if (trashedIngredients > 0) return { status: 'blocked' as const };
    const row = await restoreRecipe(tx, organizationId, id);
    return { status: row ? ('done' as const) : ('not_found' as const) };
  });

  if (outcome.status === 'blocked') {
    return {
      ok: false,
      error:
        "This recipe uses ingredients that are also in the trash. Restore those ingredients first.",
    };
  }
  if (outcome.status === 'not_found') {
    return { ok: false, error: 'Item not found in the trash.' };
  }
  revalidateTrash();
  return { ok: true, data: undefined };
}

export async function restoreIngredientAction(
  id: string,
): Promise<ActionResult> {
  const organizationId = await getOrgId();
  const row = await withOrg(organizationId, (tx) =>
    restoreIngredient(tx, organizationId, id),
  );
  if (!row) return { ok: false, error: 'Item not found in the trash.' };
  revalidateTrash();
  return { ok: true, data: undefined };
}

export async function purgeRecipeAction(id: string): Promise<ActionResult> {
  const organizationId = await getOrgId();
  await withOrg(organizationId, (tx) => purgeRecipe(tx, organizationId, id));
  revalidateTrash();
  return { ok: true, data: undefined };
}

export async function purgeIngredientAction(id: string): Promise<ActionResult> {
  const organizationId = await getOrgId();
  try {
    await withOrg(organizationId, (tx) =>
      purgeIngredient(tx, organizationId, id),
    );
  } catch (err) {
    // restrict FK: still referenced by a trashed recipe's line.
    if (isForeignKeyViolation(err)) {
      return {
        ok: false,
        error:
          'This ingredient is still part of a trashed recipe. Delete that recipe permanently first.',
      };
    }
    throw err;
  }
  revalidateTrash();
  return { ok: true, data: undefined };
}
