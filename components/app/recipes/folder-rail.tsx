'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  ChevronDown,
  ChevronUp,
  Folder,
  Inbox,
  Layers,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import type { FolderListing } from '@/lib/data/recipe-folders';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  createFolderAction,
  deleteFolderAction,
  renameFolderAction,
  reorderFolderAction,
} from '@/app/(app)/recipes/folder-actions';

/**
 * Left rail for /recipes: "All recipes" + each folder + "No folder", each with a
 * live count. Navigation is by `?folder=` (a Link per view), so it is server-
 * rendered and refresh-stable. Folder management (create / rename / reorder /
 * delete) calls the server actions and `router.refresh()`s to repaint counts.
 * Native controls only; the destructive delete reuses the shared ConfirmDialog.
 */
export function FolderRail({
  listing,
  activeKey,
}: {
  listing: FolderListing;
  /** 'all' | 'none' | a folder id — which view is selected. */
  activeKey: string;
}) {
  const t = useTranslations('recipes.folders');
  const tCommon = useTranslations('common');
  const router = useRouter();

  const [error, setError] = React.useState<string | null>(null);
  const [newName, setNewName] = React.useState('');
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameText, setRenameText] = React.useState('');
  const [deleteTarget, setDeleteTarget] = React.useState<{
    id: string;
    name: string;
  } | null>(null);
  const [pending, startTransition] = React.useTransition();

  const { folders, uncategorizedCount, totalCount } = listing;

  const onCreate = () => {
    const name = newName.trim();
    if (name === '') {
      setError(t('errors.nameRequired'));
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createFolderAction({ name });
      if (result.ok) {
        setNewName('');
        router.push(`/recipes?folder=${result.data.id}`);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  const commitRename = () => {
    if (!renamingId) return;
    const name = renameText.trim();
    if (name === '') {
      setError(t('errors.nameRequired'));
      return;
    }
    const id = renamingId;
    setError(null);
    startTransition(async () => {
      const result = await renameFolderAction(id, { name });
      if (result.ok) {
        setRenamingId(null);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  const reorder = (id: string, direction: 'up' | 'down') => {
    setError(null);
    startTransition(async () => {
      const result = await reorderFolderAction(id, { direction });
      if (result.ok) router.refresh();
      else setError(result.error);
    });
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setError(null);
    startTransition(async () => {
      const result = await deleteFolderAction(id);
      if (result.ok) {
        // If the deleted folder was the active view, fall back to "All recipes".
        if (activeKey === id) router.push('/recipes');
        router.refresh();
      } else {
        setError(result.error);
      }
      setDeleteTarget(null);
    });
  };

  return (
    <nav
      aria-label={t('title')}
      className="flex flex-col gap-1 rounded-xl border border-border bg-surface p-2"
    >
      {error && (
        <div
          role="alert"
          className="mb-1 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      )}

      <FolderLink
        href="/recipes"
        active={activeKey === 'all'}
        icon={<Layers className="size-4 shrink-0" />}
        label={t('allRecipes')}
        count={totalCount}
      />

      {folders.map((folder, index) => {
        const active = activeKey === folder.id;
        const isRenaming = renamingId === folder.id;
        return (
          <div
            key={folder.id}
            className={cn(
              'group flex items-center gap-1 rounded-lg pr-1',
              active && 'bg-accent-50 dark:bg-accent-500/15',
            )}
          >
            {isRenaming ? (
              <Input
                aria-label={t('rename')}
                autoFocus
                className="h-8 flex-1"
                value={renameText}
                disabled={pending}
                onChange={(e) => setRenameText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setRenamingId(null);
                }}
                onBlur={commitRename}
              />
            ) : (
              <FolderLink
                href={`/recipes?folder=${folder.id}`}
                active={active}
                bare
                icon={<Folder className="size-4 shrink-0" />}
                label={folder.name}
                count={folder.recipeCount}
              />
            )}

            {!isRenaming && (
              <div className="flex shrink-0 items-center opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                <RailIcon
                  label={t('moveUp')}
                  disabled={pending || index === 0}
                  onClick={() => reorder(folder.id, 'up')}
                >
                  <ChevronUp className="size-4" />
                </RailIcon>
                <RailIcon
                  label={t('moveDown')}
                  disabled={pending || index === folders.length - 1}
                  onClick={() => reorder(folder.id, 'down')}
                >
                  <ChevronDown className="size-4" />
                </RailIcon>
                <RailIcon
                  label={t('rename')}
                  disabled={pending}
                  onClick={() => {
                    setError(null);
                    setRenamingId(folder.id);
                    setRenameText(folder.name);
                  }}
                >
                  <Pencil className="size-4" />
                </RailIcon>
                <RailIcon
                  label={t('delete')}
                  disabled={pending}
                  onClick={() =>
                    setDeleteTarget({ id: folder.id, name: folder.name })
                  }
                >
                  <Trash2 className="size-4" />
                </RailIcon>
              </div>
            )}
          </div>
        );
      })}

      <FolderLink
        href="/recipes?folder=none"
        active={activeKey === 'none'}
        icon={<Inbox className="size-4 shrink-0" />}
        label={t('noFolder')}
        count={uncategorizedCount}
      />

      <div className="mt-2 flex items-center gap-1.5 border-t border-border pt-2">
        <Input
          aria-label={t('create')}
          placeholder={t('newPlaceholder')}
          className="h-8"
          value={newName}
          disabled={pending}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCreate();
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="size-8 shrink-0 px-0"
          aria-label={t('create')}
          disabled={pending}
          onClick={onCreate}
        >
          <Plus className="size-4" />
        </Button>
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('deleteConfirm.title')}
        description={t('deleteConfirm.body', { name: deleteTarget?.name ?? '' })}
        confirmLabel={tCommon('delete')}
        cancelLabel={tCommon('cancel')}
        destructive
        pending={pending}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </nav>
  );
}

function FolderLink({
  href,
  active,
  icon,
  label,
  count,
  bare = false,
}: {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  label: string;
  count: number;
  /** When inside an already-highlighted folder row, skip the own background. */
  bare?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors',
        active
          ? 'font-medium text-accent-700 dark:text-accent-300'
          : 'text-foreground hover:bg-surface-2',
        !bare && active && 'bg-accent-50 dark:bg-accent-500/15',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {count}
      </span>
    </Link>
  );
}

function RailIcon({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}
