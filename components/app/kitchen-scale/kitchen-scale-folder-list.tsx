'use client';

import Link from 'next/link';
import { ChevronRight, Scale } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { KitchenScaleSearchItem } from './kitchen-scale-home';
import { rememberKitchenScaleListReturn } from './kitchen-scale-list-return';

/**
 * The full-width recipe list shown after clicking a Kitchen Scale folder tile
 * (or "All" / "Unfiled"). Recipe names stay prominent; no financial info or
 * unnecessary metadata — just the name and a scale icon. Recent-activity order
 * is preserved (the page passes recipes already sorted).
 */
export function KitchenScaleFolderList({
  recipes,
  href,
}: {
  recipes: KitchenScaleSearchItem[];
  /** The current folder URL (`/kitchen-scale?folder=...`), remembered for "Back to recipes". */
  href: string;
}) {
  const t = useTranslations('kitchenScale.list');

  if (recipes.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
        {t('empty')}
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
      {recipes.map((recipe) => (
        <li key={recipe.id}>
          <Link
            href={`/kitchen-scale/${recipe.id}`}
            onClick={() => rememberKitchenScaleListReturn({ href, query: '' })}
            className="flex items-center gap-3 px-4 py-4 transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
          >
            <Scale className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-base font-medium text-foreground">
              {recipe.name}
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}
