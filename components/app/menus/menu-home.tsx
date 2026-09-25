'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Folder, FolderPlus, Inbox, Move, Plus, Search, UtensilsCrossed } from 'lucide-react';
import type { DishSearchResult, MenuFolderSummary } from '@/lib/data/menus';
import { folderChildren } from '@/lib/folders/tree';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { useActionError } from '@/lib/i18n/use-action-error';
import {
  createMenuFolderAction,
  moveMenuFolderAction,
  searchDishesAction,
} from '@/app/(app)/menus/actions';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Toast } from '@/components/ui/toast';
import { Input } from '@/components/ui/input';
import { FolderTile } from '@/components/app/shared/folders/folder-tile';
import { FolderMenu } from '@/components/app/shared/folders/folder-menu';
import { MoveToFolderDialog } from '@/components/app/shared/folders/move-to-folder-dialog';
import { useFolderDragAndDrop } from '@/components/app/shared/folders/use-folder-drag';

type Notice = { message: string; undo: (() => void) | null; isError?: boolean };

/**
 * Menu home (Menu redesign) — deliberately minimal, file-manager style: one big
 * search across EVERY dish, a grid of TOP-LEVEL folders, and a New folder tile.
 * Typing replaces the grid with results; clearing brings the folders back. A
 * folder can be dragged onto another to nest it (manager-only, matching every
 * other folder mutation here), or moved via its menu's "Move to…".
 */
export function MenuHome({
  folders,
  unfiledCount,
  canManage,
}: {
  folders: MenuFolderSummary[];
  unfiledCount: number;
  canManage: boolean;
}) {
  const t = useTranslations('menus.home');
  const tFolder = useTranslations('menus.folder');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();

  const [query, setQuery] = React.useState('');
  const debounced = useDebouncedValue(query.trim(), 200);
  const [results, setResults] = React.useState<DishSearchResult[] | null>(null);
  const [searching, setSearching] = React.useState(false);

  React.useEffect(() => {
    if (debounced === '') {
      setResults(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    void searchDishesAction({ query: debounced }).then((result) => {
      if (cancelled) return;
      setSearching(false);
      setResults(result.ok ? result.data : []);
    });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  const [creating, setCreating] = React.useState(false);
  const [folderName, setFolderName] = React.useState('');
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [moveTarget, setMoveTarget] = React.useState<{ id: string; name: string } | null>(null);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.undo ? 8000 : 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const rootFolders = React.useMemo(() => folderChildren(folders, null), [folders]);

  function createFolder() {
    const name = folderName.trim();
    if (!name) return;
    setCreateError(null);
    startTransition(async () => {
      const result = await createMenuFolderAction({ name });
      if (!result.ok) {
        setCreateError(actionError(result.code));
        return;
      }
      setCreating(false);
      setFolderName('');
      router.push(`/menus/folders/${result.data.id}`);
    });
  }

  function performMove(id: string, newParentId: string | null) {
    const folder = folders.find((f) => f.id === id);
    startTransition(async () => {
      const result = await moveMenuFolderAction(id, { parentId: newParentId });
      if (!result.ok) {
        setNotice({ message: actionError(result.code), undo: null, isError: true });
        return;
      }
      const previousParentId = result.data.previousParentId;
      const destination = newParentId ? folders.find((f) => f.id === newParentId)?.name : null;
      setNotice({
        message: destination
          ? tFolder('moved', { name: folder?.name ?? '', parent: destination })
          : tFolder('movedTopLevel', { name: folder?.name ?? '' }),
        undo: () => performMove(id, previousParentId),
      });
      router.refresh();
    });
  }

  const drag = useFolderDragAndDrop({
    folders,
    onMove: (id, newParentId) => performMove(id, newParentId),
    disabled: !canManage,
  });

  const showResults = query.trim() !== '';

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
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
              if (e.key === 'Enter' && results && results[0]) router.push(`/menus/${results[0].id}`);
              if (e.key === 'Escape') setQuery('');
            }}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            autoFocus
            className="h-14 rounded-2xl pl-12 text-base shadow-sm"
          />
        </div>
        {canManage && (
          <Button asChild size="lg" className="h-14 shrink-0 rounded-2xl">
            <Link href="/menus/new">
              <Plus />
              {t('newProduct')}
            </Link>
          </Button>
        )}
      </div>

      {showResults ? (
        <section aria-live="polite" className="flex flex-col gap-2">
          {results === null || (searching && results.length === 0) ? (
            <p className="px-1 text-sm text-muted-foreground">{t('searching')}</p>
          ) : results.length === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">{t('noResults', { query: query.trim() })}</p>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
              {results.map((dish) => (
                <li key={dish.id}>
                  <Link
                    href={`/menus/${dish.id}`}
                    className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                  >
                    <UtensilsCrossed className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">{dish.name}</span>
                    <span className="shrink-0 truncate text-xs text-muted-foreground">
                      {dish.folderPath ?? tFolder('unfiled')}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <section
          aria-label={t('foldersLabel')}
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
        >
          {rootFolders.map((folder) => (
            <div key={folder.id} className="relative focus-within:z-30">
              <FolderTile
                href={`/menus/folders/${folder.id}`}
                name={folder.name}
                caption={t('dishCount', { count: folder.dishCount })}
                icon={<Folder className="size-6" aria-hidden />}
                dragProps={canManage ? drag.getTileProps(folder.id) : undefined}
                isDragSource={drag.draggingId === folder.id}
                dropState={drag.overId === folder.id ? (drag.committing ? 'commit' : 'candidate') : null}
              />
              {canManage && (
                <FolderMenu
                  label={t('folderActions', { name: folder.name })}
                  disabled={pending}
                  items={[
                    {
                      label: tFolder('moveToFolder'),
                      icon: <Move className="size-4" />,
                      onSelect: () => setMoveTarget({ id: folder.id, name: folder.name }),
                    },
                  ]}
                />
              )}
            </div>
          ))}
          {unfiledCount > 0 && (
            <FolderTile
              href="/menus/folders/unfiled"
              name={tFolder('unfiled')}
              caption={t('dishCount', { count: unfiledCount })}
              icon={<Inbox className="size-6" aria-hidden />}
              muted
            />
          )}
          {canManage && (
            <button
              type="button"
              onClick={() => {
                setCreateError(null);
                setCreating(true);
              }}
              className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border p-4 text-sm font-medium text-muted-foreground transition-colors hover:border-accent-300 hover:text-accent-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:text-accent-300"
            >
              <FolderPlus className="size-6" aria-hidden />
              {t('newFolder')}
            </button>
          )}
          {rootFolders.length === 0 && unfiledCount === 0 && (
            <p className="col-span-full text-sm text-muted-foreground">
              {canManage ? t('emptyManager') : t('emptyKitchen')}
            </p>
          )}
        </section>
      )}

      <ConfirmDialog
        open={creating}
        title={t('newFolder')}
        description={t('newFolderDescription')}
        confirmLabel={t('create')}
        cancelLabel={t('cancel')}
        pending={pending}
        onConfirm={createFolder}
        onCancel={() => setCreating(false)}
      >
        <div className="flex flex-col gap-1.5">
          <Input
            value={folderName}
            maxLength={80}
            autoFocus
            placeholder={t('folderNamePlaceholder')}
            aria-label={t('folderName')}
            onChange={(e) => setFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                createFolder();
              }
            }}
          />
          {createError && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {createError}
            </p>
          )}
        </div>
      </ConfirmDialog>

      {moveTarget && (
        <MoveToFolderDialog
          open
          folders={folders}
          folderId={moveTarget.id}
          pending={pending}
          labels={{
            title: tFolder('moveDialog.title'),
            description: tFolder('moveDialog.description', { name: moveTarget.name }),
            searchPlaceholder: tFolder('moveDialog.search'),
            topLevel: tCommon('topLevel'),
            moveLabel: tFolder('moveDialog.move'),
            cancelLabel: tCommon('cancel'),
            noResults: tCommon('noMatches'),
            empty: tFolder('moveDialog.empty'),
          }}
          onMove={(newParentId) => {
            performMove(moveTarget.id, newParentId);
            setMoveTarget(null);
          }}
          onCancel={() => setMoveTarget(null)}
        />
      )}

      {notice && (
        <Toast
          message={notice.message}
          isError={notice.isError}
          undoLabel={notice.undo ? tCommon('undo') : undefined}
          onUndo={notice.undo ?? undefined}
          undoDisabled={pending}
          dismissLabel={tCommon('close')}
          onDismiss={() => setNotice(null)}
        />
      )}
    </div>
  );
}
