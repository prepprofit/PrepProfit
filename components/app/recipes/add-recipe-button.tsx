'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * "Add recipe" opens the recipe editor straight away (`/recipes/new`) — nothing is
 * created until the chef saves, so backing out never leaves an empty recipe. Started
 * inside a folder, that folder is preselected; `scope` tells Cancel which list to
 * return to. The save action enforces the role rules and the plan's recipe cap.
 */
export function AddRecipeButton({
  defaultFolderId,
  scope,
  className,
}: {
  /** The folder the new recipe is filed into unless the chef picks another. */
  defaultFolderId: string | null;
  /** The list it was opened from when that isn't a folder: every recipe or Unfiled. */
  scope?: 'all' | 'none';
  className?: string;
}) {
  const t = useTranslations('recipes.home');
  const params = new URLSearchParams();
  if (defaultFolderId) params.set('folder', defaultFolderId);
  else if (scope) params.set('from', scope);
  const query = params.toString();

  return (
    <Button asChild className={className}>
      <Link href={query ? `/recipes/new?${query}` : '/recipes/new'}>
        <Plus className="size-4" aria-hidden />
        {t('addRecipe')}
      </Link>
    </Button>
  );
}
