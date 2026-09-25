'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Folder, FolderPlus, Inbox, Layers, Search } from 'lucide-react';
import type { FolderListing } from '@/lib/data/recipe-folders';
import { folderAncestorLabel, folderChildren, folderPath } from '@/lib/folders/tree';
import { searchLibrary } from '@/lib/recipes/library-order';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { FolderTile } from '@/components/app/shared/folders/folder-tile';
import { FolderMenu } from '@/components/app/shared/folders/folder-menu';
import {
  FolderBreadcrumb,
  type BreadcrumbCrumb,
} from '@/components/app/shared/folders/folder-breadcrumb';
import { ROOT_DROP_ID } from '@/components/app/shared/folders/use-folder-drag';
import { cn } from '@/lib/utils';
import { AddRecipeButton } from './add-recipe-button';
import { LibraryTable, type LibraryTableRow } from './library-table';
import { RecipeList } from './recipe-list';
import { useFolderAdmin } from './use-folder-admin';
import { readRecipeListReturn } from './recipe-list-return';

/**
 * The in-folder view of /recipes, top to bottom, in exactly this order:
 *
 *   1. breadcrumb · 2. folder name + INCLUSIVE recipe count + compact "Add
 *   recipe" · 3. a large search · 4. compact shortcuts to the IMMEDIATE
 *   subfolders · 5. the recipe list.
 *
 * The list is the folder's WHOLE SUBTREE (lib/folders/recipe-scope.ts) — the
 * page scopes it server-side, so a folder that only holds subfolders still
 * lists their recipes instead of claiming it is empty. Search runs over that
 * same recursive scope; while it is active the folder shortcuts step aside and
 * a scoped result count takes their place, with a one-click way to widen the
 * search to the whole business when nothing matched here.
 *
 * Folder management (create/rename/reorder/delete/move, drag-and-drop, Undo)
 * comes from `useFolderAdmin`, shared with the Recipes landing page.
 */
export function RecipeFolderView({
  listing,
  activeKey,
  folderId,
  rows,
  showMoney,
  currency,
  isCards,
  initialQuery,
  viewToggle,
  secondaryLinks,
}: {
  listing: FolderListing;
  /** 'all' | 'none' | a folder id — drives the empty-state copy and the view links. */
  activeKey: string;
  /** The open folder, or null for the "All" / "Unfiled" pseudo-views. */
  folderId: string | null;
  /** Already scoped to this folder's subtree, in recent-activity order, money-stripped for kitchen. */
  rows: LibraryTableRow[];
  showMoney: boolean;
  currency: string;
  isCards: boolean;
  /** `?q=` — set when a search was widened to the whole business from a folder. */
  initialQuery: string;
  viewToggle: React.ReactNode;
  secondaryLinks: React.ReactNode;
}) {
  const t = useTranslations('recipes.home');
  const tFolders = useTranslations('recipes.folders');
  const router = useRouter();

  const folder = folderId ? (listing.folders.find((f) => f.id === folderId) ?? null) : null;
  const scopeName = folder ? folder.name : activeKey === 'all' ? t('allTitle') : t('unfiled');

  const [query, setQuery] = React.useState(initialQuery);
  // Returning from a recipe brings this list's search back (same memory the
  // table uses for its sort and scroll position).
  React.useEffect(() => {
    if (initialQuery !== '') return;
    const saved = readRecipeListReturn();
    if (saved?.href.startsWith('/recipes?') && saved.query) setQuery(saved.query);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore once on mount
  }, []);

  const searching = query.trim() !== '';
  const visibleRows = React.useMemo(
    () => (searching ? searchLibrary(rows, query) : rows),
    [rows, query, searching],
  );

  const recipeName = React.useCallback(
    (id: string) => rows.find((r) => r.id === id)?.name,
    [rows],
  );
  const admin = useFolderAdmin({ listing, parentId: folderId, recipeName });
  const { drag } = admin;

  const subfolders = folder ? folderChildren(listing.folders, folder.id) : [];
  const crumbs: BreadcrumbCrumb[] = folder
    ? [
        { key: 'root', label: t('back'), href: '/recipes', dropId: ROOT_DROP_ID },
        ...folderPath(listing.folders, folder.id).map((f) => ({
          key: f.id,
          label: f.name,
          href: `/recipes?folder=${f.id}`,
          dropId: f.id,
        })),
      ]
    : [];

  /** Only useful where a recipe may not live in the folder being browsed. */
  const folderPathFor = React.useCallback(
    (id: string | null): string | null => {
      if (id === null || id === folderId) return null;
      const self = listing.folders.find((f) => f.id === id);
      if (!self) return null;
      const ancestors = folderAncestorLabel(listing.folders, id, ' › ');
      return ancestors ? `${ancestors} › ${self.name}` : self.name;
    },
    [listing.folders, folderId],
  );

  return (
    <div className="flex w-full flex-col gap-4">
      {folder ? (
        <FolderBreadcrumb crumbs={crumbs} getDropProps={drag.getDropTargetProps} dropStateOf={drag.dropStateOf} />
      ) : (
        <Link
          href="/recipes"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {t('back')}
        </Link>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-xl',
              folder || activeKey === 'all'
                ? 'bg-accent-50 text-accent-700 dark:bg-accent-500/15 dark:text-accent-300'
                : 'bg-surface-2 text-muted-foreground',
            )}
          >
            {folder?.icon ? (
              <span aria-hidden className="text-base leading-none">
                {folder.icon}
              </span>
            ) : folder ? (
              <Folder className="size-4" aria-hidden />
            ) : activeKey === 'all' ? (
              <Layers className="size-4" aria-hidden />
            ) : (
              <Inbox className="size-4" aria-hidden />
            )}
          </span>
          <div className="flex min-w-0 flex-col">
            <h2 className="truncate font-display text-xl font-semibold tracking-tight text-foreground">
              {scopeName}
            </h2>
            <p className="text-xs text-muted-foreground">{t('recipeCount', { count: rows.length })}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {viewToggle}
          <AddRecipeButton
            folders={listing.folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId }))}
            defaultFolderId={folderId}
            className="h-9 px-3"
          />
        </div>
      </div>

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
            if (e.key === 'Escape') setQuery('');
          }}
          placeholder={t('searchInScope', { name: scopeName })}
          aria-label={t('searchInScope', { name: scopeName })}
          className="h-12 rounded-2xl pl-12 text-base shadow-sm"
        />
      </div>

      {admin.error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/15 dark:text-red-300">
          {admin.error}
        </p>
      )}

      {searching ? (
        <div className="flex flex-wrap items-center gap-3 px-1">
          <p aria-live="polite" className="text-xs text-muted-foreground">
            {t('resultsInScope', { count: visibleRows.length, scope: scopeName })}
          </p>
          {visibleRows.length === 0 && activeKey !== 'all' && (
            <Button
              type="button"
              variant="outline"
              className="h-8 px-3 text-xs"
              onClick={() => router.push(`/recipes?folder=all&q=${encodeURIComponent(query.trim())}`)}
            >
              {t('searchEverywhere')}
            </Button>
          )}
        </div>
      ) : (
        folder !== null && (
          <section aria-label={tFolders('subfolders')} className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2 px-1">
              <h3 className="text-xs font-medium text-muted-foreground">{tFolders('subfolders')}</h3>
              <button
                type="button"
                onClick={admin.openCreate}
                disabled={admin.pending}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-accent-700 transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 dark:text-accent-300"
              >
                <FolderPlus className="size-4" aria-hidden />
                {tFolders('newSubfolder')}
              </button>
            </div>
            {subfolders.length > 0 && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                {subfolders.map((child, index) => (
                  <div key={child.id} className="relative focus-within:z-30">
                    <FolderTile
                      href={`/recipes?folder=${child.id}`}
                      name={child.name}
                      caption={t('recipeCount', { count: child.recipeCount })}
                      icon={
                        child.icon ? (
                          <span aria-hidden className="text-base leading-none">
                            {child.icon}
                          </span>
                        ) : (
                          <Folder className="size-4" aria-hidden />
                        )
                      }
                      dragProps={drag.getTileProps(child.id)}
                      isDragSource={drag.draggingId === child.id}
                      dropState={drag.dropStateOf(child.id)}
                      isInvalidTarget={
                        drag.dragging !== null && drag.draggingId !== child.id && !drag.canDropOn(child.id)
                      }
                    />
                    <FolderMenu
                      label={t('folderActions', { name: child.name })}
                      disabled={admin.pending}
                      items={admin.menuItemsFor(child, index, subfolders.length)}
                    />
                  </div>
                ))}
              </div>
            )}
          </section>
        )
      )}

      {isCards ? (
        <RecipeList
          key={activeKey}
          recipes={visibleRows.map((r) => ({
            id: r.id,
            name: r.name,
            yieldPortions: r.yieldPortions,
            folderId: r.folderId,
          }))}
          activeKey={activeKey}
          hideSearch
          folderPathOf={folderPathFor}
          onMoveToFolder={admin.openRecipeMove}
          dragPropsFor={drag.getRecipeDragProps}
          draggingRecipeId={drag.draggingRecipeId}
        />
      ) : (
        <LibraryTable
          key={activeKey}
          rows={visibleRows}
          showMoney={showMoney}
          currency={currency}
          hideSearch
          folderPathOf={folderPathFor}
          onMoveToFolder={admin.openRecipeMove}
          dragPropsFor={drag.getRecipeDragProps}
          draggingRecipeId={drag.draggingRecipeId}
        />
      )}

      <div className="border-t border-border pt-4">{secondaryLinks}</div>

      {admin.dialogs}
    </div>
  );
}
