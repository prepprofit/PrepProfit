'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowLeft } from 'lucide-react';
import { readRecipeListReturn } from './recipe-list-return';

/**
 * "Back to recipes" on the recipe page: returns to the list the user actually came
 * from (folder, All, or the home search — with its search, sort and scroll restored
 * by that list). A recipe opened directly falls back to its own folder, or All.
 */
export function BackToRecipesLink({
  folderId,
  onNavigate,
}: {
  folderId: string | null;
  /** Lets the page intercept (e.g. to confirm discarding unsaved edits). */
  onNavigate?: (href: string, event: React.MouseEvent) => void;
}) {
  const t = useTranslations('recipes.workspace');
  const fallback = folderId ? `/recipes?folder=${folderId}` : '/recipes?folder=all';
  const [href, setHref] = React.useState(fallback);

  React.useEffect(() => {
    const saved = readRecipeListReturn();
    if (saved) setHref(saved.href);
  }, []);

  return (
    <Link
      href={href}
      onClick={(e) => onNavigate?.(href, e)}
      className="inline-flex w-fit items-center gap-1.5 rounded text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft className="size-4" aria-hidden />
      {t('backToRecipes')}
    </Link>
  );
}
