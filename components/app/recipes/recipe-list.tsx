'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronRight, FolderInput, Search, Trash2 } from 'lucide-react';
import type { Recipe } from '@/lib/db/schema';
import { Input } from '@/components/ui/input';
// The list never shows money — accept only the operational fields, so a recipe's
// cost/selling price is not even part of this client component's props (Sprint F4).
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { deleteRecipeAction } from '@/app/(app)/recipes/actions';
import { useActionError } from '@/lib/i18n/use-action-error';
import { cn } from '@/lib/utils';
import { rememberRecipeListReturn, scrollContainer } from './recipe-list-return';

export type FolderOption = { id: string; name: string; parentId: string | null };

/** Operational recipe fields the list renders — deliberately no money (Sprint F4). */
export type RecipeListItem = Pick<
  Recipe,
  'id' | 'name' | 'yieldPortions' | 'folderId'
>;

/**
 * Recipe grid for the active folder view. Server-driven: it renders the recipes
 * the page already filtered (by org, `deleted_at IS NULL`, and the selected
 * folder) in recent-activity order, and every mutation calls a Server Action then `router.refresh()` so
 * the grid and the folder rail's counts stay in sync. The page keys this on the
 * active view, so switching folders re-mounts it with the right list.
 */
export function RecipeList({
  recipes,
  activeKey,
  hideSearch = false,
  folderPathOf,
  onMoveToFolder,
  dragPropsFor,
  draggingRecipeId = null,
}: {
  recipes: RecipeListItem[];
  /** 'none' | a folder id — drives the empty-state copy. */
  activeKey: string;
  /** The page owns the search box (the folder view's large one) — hide this grid's own. */
  hideSearch?: boolean;
  /** "Linda's › Fillings" under a name, when the recipe isn't in the folder being browsed. */
  folderPathOf?: (folderId: string | null) => string | null;
  /** Opens the searchable "Move to…" picker — replaces the old flat folder `<select>`. */
  onMoveToFolder?: (recipe: { id: string; name: string }) => void;
  /** From `useFolderDragAndDrop().getRecipeDragProps` — lets a card be dragged onto a folder. */
  dragPropsFor?: (recipeId: string) => Record<string, unknown>;
  draggingRecipeId?: string | null;
}) {
  const t = useTranslations('recipes');
  const tFolders = useTranslations('recipes.folders');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const listHref = `${pathname}${searchParams.toString() ? `?${searchParams.toString()}` : ''}`;
  const [query, setQuery] = React.useState('');
  const q = query.trim().toLowerCase();
  const visibleRecipes = q
    ? recipes.filter((r) => r.name.toLowerCase().includes(q))
    : recipes;
  const [error, setError] = React.useState<string | null>(null);
  const [confirmId, setConfirmId] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const confirmTarget = recipes.find((r) => r.id === confirmId) ?? null;
  const inFolder = activeKey !== 'all' && activeKey !== 'none';

  const confirmDelete = () => {
    const id = confirmId;
    if (!id) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteRecipeAction(id);
      if (result.ok) router.refresh();
      else setError(actionError(result.code));
      setConfirmId(null);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {!hideSearch && (
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            aria-label={tCommon('searchPlaceholder')}
            placeholder={tCommon('searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
      )}

      {visibleRecipes.length === 0 ? (
        <p className="px-1 py-8 text-center text-sm text-muted-foreground">
          {q
            ? tCommon('noMatches')
            : inFolder
              ? tFolders('emptyFolder')
              : t('empty')}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visibleRecipes.map((recipe) => {
            const path = folderPathOf?.(recipe.folderId) ?? null;
            return (
            <li
              key={recipe.id}
              {...dragPropsFor?.(recipe.id)}
              className={cn(
                'flex flex-col gap-3 rounded-xl border border-border bg-surface p-4',
                draggingRecipeId === recipe.id && 'opacity-40',
              )}
            >
              <Link
                href={`/recipes/${recipe.id}`}
                onClick={() => rememberRecipeListReturn({ href: listHref, query, sort: 'recent', scrollTop: scrollContainer()?.scrollTop ?? 0 })}
                draggable={false}
                className="group flex min-w-0 items-center justify-between gap-2"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[18px] font-semibold leading-snug text-foreground">
                    {recipe.name}
                  </span>
                  {path && <span className="truncate text-xs text-muted-foreground">{path}</span>}
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
              <div className="flex items-center gap-2">
                {onMoveToFolder && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 flex-1 text-xs"
                    disabled={pending}
                    onClick={() => onMoveToFolder({ id: recipe.id, name: recipe.name })}
                  >
                    <FolderInput className="size-4" aria-hidden />
                    {tFolders('moveTo')}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="size-9 shrink-0 px-0"
                  aria-label={t('actions.delete')}
                  disabled={pending}
                  onClick={() => setConfirmId(recipe.id)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={confirmId !== null}
        title={t('deleteConfirm.title')}
        description={t('deleteConfirm.body', { name: confirmTarget?.name ?? '' })}
        confirmLabel={tCommon('moveToTrash')}
        cancelLabel={tCommon('cancel')}
        pending={pending}
        onConfirm={confirmDelete}
        onCancel={() => setConfirmId(null)}
      />
    </div>
  );
}
