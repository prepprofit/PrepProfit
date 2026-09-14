'use server';

import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { unexpected } from '@/lib/observability';
import { getRecipeWorkspace } from '@/lib/data/recipe-workspace';
import { loadRecipeFinishedWeights } from '@/lib/data/recipe-yield';
import { buildRecipeDocument, type RecipeDocument } from '@/lib/recipes/recipe-document';
import type { ActionResult } from '@/lib/action-result';

/**
 * Quick recipe preview for the recipe list (both roles). Loads the KITCHEN
 * (money-free) workspace shape, so no price or cost can reach the preview.
 * Org-scoped under `withOrg`; a trashed or other-org id is NOT_FOUND.
 */
export async function getRecipeQuickViewAction(id: string): Promise<ActionResult<RecipeDocument>> {
  if (typeof id !== 'string' || id.trim() === '' || id.length > 64) return { ok: false, code: 'INVALID_INPUT' };
  try {
    const organizationId = await getOrgId();
    const doc = await withOrg(organizationId, async (tx) => {
      const dto = await getRecipeWorkspace(tx, organizationId, id, 'kitchen');
      if (!dto) return null;
      const weights = await loadRecipeFinishedWeights(tx, organizationId, [dto.recipe]);
      return buildRecipeDocument(dto, weights.get(dto.recipe.id) ?? null);
    });
    if (!doc) return { ok: false, code: 'NOT_FOUND' };
    return { ok: true, data: doc };
  } catch (error) {
    return unexpected('getRecipeQuickViewAction', error);
  }
}
