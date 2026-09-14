'use client';

import * as React from 'react';
import { markRecipeOpenedAction } from '@/app/(app)/recipes/actions';

/**
 * Records that the recipe page was opened, once per mount. Lives on the recipe
 * detail page only — lists, search results and link prefetches never count as
 * opening. Best-effort: a failure never affects the page.
 */
export function RecipeOpenedTracker({ recipeId }: { recipeId: string }) {
  React.useEffect(() => {
    void markRecipeOpenedAction(recipeId).catch(() => undefined);
  }, [recipeId]);
  return null;
}
