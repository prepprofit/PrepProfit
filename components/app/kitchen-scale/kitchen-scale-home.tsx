'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronRight, Folder, Inbox, Layers, Search } from 'lucide-react';
import type { FolderListing } from '@/lib/data/recipe-folders';
import { searchLibrary } from '@/lib/recipes/library-order';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { readKitchenScaleListReturn, rememberKitchenScaleListReturn } from './kitchen-scale-list-return';

/** What the home search needs per recipe — operational fields only, never money. */
export type KitchenScaleSearchItem = {
  id: string;
  name: string;
  folderId: string | null;
  recentActivityAt: Date;
};

/**
 * Kitchen Scale home: a large search across every folder, then ONLY the folder
 * tiles ("All" first, "Unfiled" last) — no recipe grid or list alongside them.
 * Typing swaps the tiles for matching recipes (name-prominent, no financial or
 * unnecessary metadata); clearing search brings the folders back. Folders are
 * the SAME ones Recipes uses, read-only here — folder management stays on
 * `/recipes`. Clicking a folder opens the full-width recipe list.
 */
export function KitchenScaleHome({
  listing,
  recipes,
}: {
  listing: FolderListing;
  /** Every active recipe, in recent-activity order. */
  recipes: KitchenScaleSearchItem[];
}) {
  const t = useTranslations('kitchenScale.home');
  const router = useRouter();

  const [query, setQuery] = React.useState('');
  // Returning from a recipe opened from the search results brings the search back.
  React.useEffect(() => {
    const saved = readKitchenScaleListReturn();
    if (saved?.href === '/kitchen-scale' && saved.query) setQuery(saved.query);
  }, []);
  const results = React.useMemo(() => searchLibrary(recipes, query), [recipes, query]);
  const showResults = query.trim() !== '';
  const folderName = React.useMemo(
    () => new Map(listing.folders.map((f) => [f.id, f.name])),
    [listing.folders],
  );

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && results[0]) router.push(`/kitchen-scale/${results[0].id}`);
            if (e.key === 'Escape') setQuery('');
          }}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchPlaceholder')}
          className="h-14 rounded-2xl pl-12 text-base shadow-sm"
        />
      </div>

      {showResults ? (
        <section aria-live="polite" aria-label={t('resultsLabel')} className="flex flex-col gap-2">
          {results.length === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">{t('noResults', { query: query.trim() })}</p>
          ) : (
            <>
              <p className="px-1 text-xs text-muted-foreground">{t('resultCount', { count: results.length })}</p>
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
                {results.map((recipe) => (
                  <li key={recipe.id}>
                    <Link
                      href={`/kitchen-scale/${recipe.id}`}
                      onClick={() => rememberKitchenScaleListReturn({ href: '/kitchen-scale', query })}
                      className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                    >
                      <span className="min-w-0 flex-1 truncate text-base font-medium text-foreground">
                        {recipe.name}
                      </span>
                      <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
                        {recipe.folderId ? (folderName.get(recipe.folderId) ?? t('unfiled')) : t('unfiled')}
                      </span>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ) : (
        <section
          aria-label={t('all')}
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5"
        >
          <FolderTile
            href="/kitchen-scale?folder=all"
            name={t('all')}
            caption={t('allCaption', { count: listing.totalCount })}
            icon={<Layers className="size-5" aria-hidden />}
          />
          {listing.folders.map((folder) => (
            <FolderTile
              key={folder.id}
              href={`/kitchen-scale?folder=${folder.id}`}
              name={folder.name}
              caption={t('recipeCount', { count: folder.recipeCount })}
              icon={
                folder.icon ? (
                  <span aria-hidden className="text-xl leading-none">
                    {folder.icon}
                  </span>
                ) : (
                  <Folder className="size-5" aria-hidden />
                )
              }
            />
          ))}
          <FolderTile
            href="/kitchen-scale?folder=none"
            name={t('unfiled')}
            caption={t('recipeCount', { count: listing.uncategorizedCount })}
            icon={<Inbox className="size-5" aria-hidden />}
            muted
          />
          {listing.totalCount === 0 && (
            <p className="col-span-full px-1 text-sm text-muted-foreground">{t('empty')}</p>
          )}
        </section>
      )}
    </div>
  );
}

function FolderTile({
  href,
  name,
  caption,
  icon,
  muted = false,
}: {
  href: string;
  name: string;
  caption: string;
  icon: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'flex min-h-28 flex-col justify-between gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-accent-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        muted && 'bg-surface-2/60 shadow-none',
      )}
    >
      <span
        className={cn(
          'flex size-10 items-center justify-center rounded-xl',
          muted
            ? 'bg-surface-2 text-muted-foreground'
            : 'bg-accent-50 text-accent-700 dark:bg-accent-500/15 dark:text-accent-300',
        )}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-col pr-6">
        <span className="truncate font-medium text-foreground">{name}</span>
        <span className="text-xs text-muted-foreground">{caption}</span>
      </span>
    </Link>
  );
}
