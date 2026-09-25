'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { BookOpen, Folder, FolderPlus, Inbox, Layers, Search } from 'lucide-react';
import type { FolderListing } from '@/lib/data/recipe-folders';
import { searchLibrary } from '@/lib/recipes/library-order';
import { folderChildren, folderLabel } from '@/lib/folders/tree';
import { FolderTile } from '@/components/app/shared/folders/folder-tile';
import { FolderMenu } from '@/components/app/shared/folders/folder-menu';
import { ROOT_DROP_ID } from '@/components/app/shared/folders/use-folder-drag';
import { Input } from '@/components/ui/input';
import { AddRecipeButton } from './add-recipe-button';
import { useFolderAdmin } from './use-folder-admin';
import { readRecipeListReturn, rememberRecipeListReturn, scrollContainer } from './recipe-list-return';

/** What the home search needs per recipe — operational fields only, never money. */
export type RecipeSearchItem = {
  id: string;
  name: string;
  folderId: string | null;
  recentActivityAt: Date;
};

/**
 * Recipes home: a large search across every folder with a compact "Add recipe"
 * beside it, then ONLY the TOP-LEVEL folders as compact shortcuts — "All" first,
 * "Unfiled" last. Typing swaps the shortcuts for matching recipes — best match
 * first, recent activity breaking ties — and clearing brings the folders back.
 * Recipe lists live inside folders, where opening one shows its WHOLE subtree.
 *
 * Folder management stays available but quiet: a small "New folder" button
 * beside the section heading and a discreet menu on each shortcut. A folder can
 * be dragged onto another to nest it, dragged onto "Top level" to unnest it, or
 * moved via each tile's "Move to another folder…".
 */
export function RecipeHome({
  listing,
  recipes,
}: {
  listing: FolderListing;
  /** Every active recipe, in recent-activity order. */
  recipes: RecipeSearchItem[];
}) {
  const t = useTranslations('recipes.home');
  const tFolders = useTranslations('recipes.folders');
  const router = useRouter();

  const [query, setQuery] = React.useState('');
  // Returning from a recipe opened from the search results brings the search back.
  React.useEffect(() => {
    const saved = readRecipeListReturn();
    if (saved?.href === '/recipes' && saved.query) setQuery(saved.query);
  }, []);
  const results = React.useMemo(() => searchLibrary(recipes, query), [recipes, query]);
  const showResults = query.trim() !== '';
  const rootFolders = React.useMemo(() => folderChildren(listing.folders, null), [listing.folders]);
  const folderOptions = listing.folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId }));

  const recipeName = React.useCallback((id: string) => recipes.find((r) => r.id === id)?.name, [recipes]);
  const admin = useFolderAdmin({ listing, parentId: null, recipeName });
  const { drag } = admin;

  return (
    <div className="flex w-full flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results[0]) router.push(`/recipes/${results[0].id}`);
              if (e.key === 'Escape') setQuery('');
            }}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            className="h-12 rounded-2xl pl-12 text-base shadow-sm"
          />
        </div>
        <AddRecipeButton folders={folderOptions} defaultFolderId={null} className="h-9 shrink-0 self-end px-3 sm:self-auto" />
      </div>

      {admin.error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/15 dark:text-red-300">
          {admin.error}
        </p>
      )}

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
                      href={`/recipes/${recipe.id}`}
                      onClick={() =>
                        rememberRecipeListReturn({ href: '/recipes', query, sort: 'recent', scrollTop: scrollContainer()?.scrollTop ?? 0 })
                      }
                      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                    >
                      <BookOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-base font-medium text-foreground">{recipe.name}</span>
                      <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
                        {recipe.folderId ? (folderLabel(listing.folders, recipe.folderId) || t('unfiled')) : t('unfiled')}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ) : (
        <section aria-label={tFolders('title')} className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 px-1">
            <h3 className="text-xs font-medium text-muted-foreground">{tFolders('title')}</h3>
            <button
              type="button"
              onClick={admin.openCreate}
              disabled={admin.pending}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-accent-700 transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 dark:text-accent-300"
            >
              <FolderPlus className="size-4" aria-hidden />
              {t('newFolder')}
            </button>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            <FolderTile
              href="/recipes?folder=all"
              name={t('all')}
              caption={t('allCaption', { count: listing.totalCount })}
              icon={<Layers className="size-4" aria-hidden />}
              dragProps={drag.getDropTargetProps(ROOT_DROP_ID)}
              dropState={drag.dropStateOf(ROOT_DROP_ID)}
            />
            {rootFolders.map((folder, index) => (
              <div key={folder.id} className="relative focus-within:z-30">
                <FolderTile
                  href={`/recipes?folder=${folder.id}`}
                  name={folder.name}
                  caption={t('recipeCount', { count: folder.recipeCount })}
                  icon={
                    folder.icon ? (
                      <span aria-hidden className="text-base leading-none">
                        {folder.icon}
                      </span>
                    ) : (
                      <Folder className="size-4" aria-hidden />
                    )
                  }
                  dragProps={drag.getTileProps(folder.id)}
                  isDragSource={drag.draggingId === folder.id}
                  dropState={drag.dropStateOf(folder.id)}
                  isInvalidTarget={
                    drag.dragging !== null && drag.draggingId !== folder.id && !drag.canDropOn(folder.id)
                  }
                />
                <FolderMenu
                  label={t('folderActions', { name: folder.name })}
                  disabled={admin.pending}
                  items={admin.menuItemsFor(folder, index, rootFolders.length)}
                />
              </div>
            ))}
            <FolderTile
              href="/recipes?folder=none"
              name={t('unfiled')}
              caption={t('recipeCount', { count: listing.uncategorizedCount })}
              icon={<Inbox className="size-4" aria-hidden />}
              muted
            />
            {listing.totalCount === 0 && (
              <p className="col-span-full px-1 text-sm text-muted-foreground">{t('empty')}</p>
            )}
          </div>
        </section>
      )}

      {admin.dialogs}
    </div>
  );
}
