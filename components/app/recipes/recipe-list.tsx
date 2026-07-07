'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { startWorkflow } from '@flows/react';
import { ChevronRight, Plus, Trash2 } from 'lucide-react';
import type { Recipe } from '@/lib/db/schema';
import { Input } from '@/components/ui/input';
// The list never shows money — accept only the operational fields, so a recipe's
// cost/selling price is not even part of this client component's props (Sprint F4).
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  createRecipeAction,
  deleteRecipeAction,
} from '@/app/(app)/recipes/actions';
import { moveRecipeToFolderAction } from '@/app/(app)/recipes/folder-actions';
import { useActionError } from '@/lib/i18n/use-action-error';

export type FolderOption = { id: string; name: string };

/** Operational recipe fields the list renders — deliberately no money (Sprint F4). */
export type RecipeListItem = Pick<
  Recipe,
  'id' | 'name' | 'yieldPortions' | 'folderId'
>;

/**
 * Recipe grid for the active folder view. Server-driven: it renders the recipes
 * the page already filtered (by org, `deleted_at IS NULL`, and the selected
 * folder), and every mutation calls a Server Action then `router.refresh()` so
 * the grid and the folder rail's counts stay in sync. The page keys this on the
 * active view, so switching folders re-mounts it with the right list.
 */
export function RecipeList({
  recipes,
  folders,
  createFolderId,
  activeKey,
}: {
  recipes: RecipeListItem[];
  folders: FolderOption[];
  /** Folder a newly created recipe is filed into (null = "No folder"). */
  createFolderId: string | null;
  /** 'all' | 'none' | a folder id — drives the empty-state copy. */
  activeKey: string;
}) {
  const t = useTranslations('recipes');
  const tFolders = useTranslations('recipes.folders');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();
  const [name, setName] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [confirmId, setConfirmId] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const confirmTarget = recipes.find((r) => r.id === confirmId) ?? null;
  const inFolder = activeKey !== 'all' && activeKey !== 'none';

  const onCreate = () => {
    const trimmed = name.trim();
    if (trimmed === '') {
      setError(t('errors.nameRequired'));
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createRecipeAction({
        name: trimmed,
        folderId: createFolderId,
        yieldPortions: 1,
        yieldPercentage: 100,
        laborCostCents: 0,
        energyCostCents: 0,
        packagingCostCents: 0,
      });
      if (result.ok) {
        // Best-effort celebratory nudge — never block navigation on Flows, and a Flows
        // outage must not break recipe creation. Canonical checklist completion still
        // comes from the `recipeCount` user property, so imports aren't missed.
        void startWorkflow('first-recipe-created').catch(() => undefined);
        router.push(`/recipes/${result.data.id}`);
      } else {
        setError(actionError(result.code));
      }
    });
  };

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

  const move = (recipeId: string, value: string) => {
    setError(null);
    startTransition(async () => {
      const result = await moveRecipeToFolderAction(recipeId, {
        folderId: value === '' ? null : value,
      });
      if (result.ok) router.refresh();
      else setError(actionError(result.code));
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

      <div className="flex flex-col gap-2 rounded-xl border border-dashed border-border bg-surface p-3 sm:flex-row sm:items-center">
        <Input
          aria-label={t('newName')}
          placeholder={t('placeholders.name')}
          value={name}
          disabled={pending}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCreate();
          }}
        />
        <Button type="button" onClick={onCreate} disabled={pending}>
          <Plus className="size-4" />
          {t('actions.create')}
        </Button>
      </div>

      {recipes.length === 0 ? (
        <p className="px-1 py-8 text-center text-sm text-muted-foreground">
          {inFolder ? tFolders('emptyFolder') : t('empty')}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {recipes.map((recipe) => (
            <li
              key={recipe.id}
              className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4"
            >
              <Link
                href={`/recipes/${recipe.id}`}
                className="group flex min-w-0 items-center justify-between gap-2"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium text-foreground">
                    {recipe.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t('portions', { count: recipe.yieldPortions })}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
              <div className="flex items-center gap-2">
                <Select
                  aria-label={tFolders('moveTo')}
                  className="h-9 flex-1 text-xs"
                  value={recipe.folderId ?? ''}
                  disabled={pending}
                  onChange={(e) => move(recipe.id, e.target.value)}
                >
                  <option value="">{tFolders('noFolder')}</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
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
          ))}
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
