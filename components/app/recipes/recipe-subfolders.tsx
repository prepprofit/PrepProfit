'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Folder, FolderPlus, Move, Pencil, Trash2 } from 'lucide-react';
import type { FolderListing } from '@/lib/data/recipe-folders';
import { folderChildren, folderPath } from '@/lib/folders/tree';
import { FOLDER_ICONS } from '@/lib/validation/recipe-folders';
import { useActionError } from '@/lib/i18n/use-action-error';
import {
  createFolderAction,
  deleteFolderAction,
  moveFolderAction,
  renameFolderAction,
  reorderFolderAction,
} from '@/app/(app)/recipes/folder-actions';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Toast } from '@/components/ui/toast';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FolderTile } from '@/components/app/shared/folders/folder-tile';
import { FolderMenu } from '@/components/app/shared/folders/folder-menu';
import { FolderBreadcrumb, type BreadcrumbCrumb } from '@/components/app/shared/folders/folder-breadcrumb';
import { MoveToFolderDialog } from '@/components/app/shared/folders/move-to-folder-dialog';
import { useFolderDragAndDrop } from '@/components/app/shared/folders/use-folder-drag';
import { cn } from '@/lib/utils';

type FolderDialog =
  | { mode: 'create' }
  | { mode: 'rename'; id: string; name: string; icon: string | null };

type Notice = { message: string; undo: (() => void) | null; isError?: boolean };

/**
 * Immediate subfolders of the folder currently open, shown ABOVE the recipe
 * table (app/(app)/recipes/page.tsx's folder-view branch) — never the full
 * descendant tree flattened together. Same folder CRUD + drag + "Move to…" as
 * RecipeHome's root grid, scoped to this parent, plus the breadcrumb trail.
 */
export function RecipeSubfolders({
  listing,
  parentId,
}: {
  listing: FolderListing;
  parentId: string;
}) {
  const t = useTranslations('recipes.home');
  const tFolders = useTranslations('recipes.folders');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();

  const children = React.useMemo(() => folderChildren(listing.folders, parentId), [listing.folders, parentId]);
  const path = React.useMemo(() => folderPath(listing.folders, parentId), [listing.folders, parentId]);

  const [dialog, setDialog] = React.useState<FolderDialog | null>(null);
  const [dialogName, setDialogName] = React.useState('');
  const [dialogIcon, setDialogIcon] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<{ id: string; name: string } | null>(null);
  const [moveTarget, setMoveTarget] = React.useState<{ id: string; name: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.undo ? 8000 : 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function openDialog(next: FolderDialog) {
    setError(null);
    setDialogName(next.mode === 'rename' ? next.name : '');
    setDialogIcon(next.mode === 'rename' ? next.icon : null);
    setDialog(next);
  }

  function saveFolder() {
    if (!dialog) return;
    const name = dialogName.trim();
    if (name === '') {
      setError(tFolders('errors.nameRequired'));
      return;
    }
    setError(null);
    startTransition(async () => {
      if (dialog.mode === 'create') {
        const result = await createFolderAction({ name, icon: dialogIcon, parentId });
        if (!result.ok) return setError(actionError(result.code));
        setDialog(null);
        router.push(`/recipes?folder=${result.data.id}`);
        return;
      }
      const result = await renameFolderAction(dialog.id, { name, icon: dialogIcon });
      if (!result.ok) return setError(actionError(result.code));
      setDialog(null);
      router.refresh();
    });
  }

  function reorder(id: string, direction: 'up' | 'down') {
    setError(null);
    startTransition(async () => {
      const result = await reorderFolderAction(id, { direction });
      if (result.ok) router.refresh();
      else setError(actionError(result.code));
    });
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setError(null);
    startTransition(async () => {
      const result = await deleteFolderAction(id);
      if (result.ok) router.refresh();
      else setError(actionError(result.code));
      setDeleteTarget(null);
    });
  }

  function performMove(id: string, newParentId: string | null) {
    const folder = listing.folders.find((f) => f.id === id);
    startTransition(async () => {
      const result = await moveFolderAction(id, { parentId: newParentId });
      if (!result.ok) {
        setNotice({ message: actionError(result.code), undo: null, isError: true });
        return;
      }
      const previousParentId = result.data.previousParentId;
      const destination = newParentId ? listing.folders.find((f) => f.id === newParentId)?.name : null;
      setNotice({
        message: destination
          ? tFolders('moved', { name: folder?.name ?? '', parent: destination })
          : tFolders('movedTopLevel', { name: folder?.name ?? '' }),
        undo: () => performMove(id, previousParentId),
      });
      router.refresh();
    });
  }

  const drag = useFolderDragAndDrop({
    folders: listing.folders,
    onMove: (id, newParentId) => performMove(id, newParentId),
  });

  const crumbs: BreadcrumbCrumb[] = [
    { key: 'root', label: t('back'), href: '/recipes' },
    ...path.map((f) => ({ key: f.id, label: f.name, href: `/recipes?folder=${f.id}` })),
  ];

  return (
    <div className="flex flex-col gap-4">
      <FolderBreadcrumb crumbs={crumbs} />

      <section aria-label={tFolders('subfolders')} className="flex flex-col gap-2">
        {children.length > 0 && (
          <h3 className="px-1 text-xs font-medium text-muted-foreground">{tFolders('subfolders')}</h3>
        )}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
          {children.map((folder, index) => (
              <div key={folder.id} className="relative focus-within:z-30">
                <FolderTile
                  href={`/recipes?folder=${folder.id}`}
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
                  dragProps={drag.getTileProps(folder.id)}
                  isDragSource={drag.draggingId === folder.id}
                  dropState={drag.overId === folder.id ? (drag.committing ? 'commit' : 'candidate') : null}
                />
                <FolderMenu
                  label={t('folderActions', { name: folder.name })}
                  disabled={pending}
                  items={[
                    {
                      label: tFolders('rename'),
                      icon: <Pencil className="size-4" />,
                      onSelect: () => openDialog({ mode: 'rename', id: folder.id, name: folder.name, icon: folder.icon }),
                    },
                    {
                      label: tFolders('moveToFolder'),
                      icon: <Move className="size-4" />,
                      onSelect: () => setMoveTarget({ id: folder.id, name: folder.name }),
                    },
                    {
                      label: tFolders('moveUp'),
                      icon: <ArrowUp className="size-4" />,
                      disabled: index === 0,
                      onSelect: () => reorder(folder.id, 'up'),
                    },
                    {
                      label: tFolders('moveDown'),
                      icon: <ArrowDown className="size-4" />,
                      disabled: index === children.length - 1,
                      onSelect: () => reorder(folder.id, 'down'),
                    },
                    {
                      label: tFolders('delete'),
                      icon: <Trash2 className="size-4" />,
                      destructive: true,
                      onSelect: () => setDeleteTarget({ id: folder.id, name: folder.name }),
                    },
                  ]}
                />
              </div>
            ))}
            <button
              type="button"
              onClick={() => openDialog({ mode: 'create' })}
              className={cn(
                'flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground transition-colors hover:border-accent-300 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            >
              <FolderPlus className="size-5" aria-hidden />
              {tFolders('newSubfolder')}
            </button>
        </div>
      </section>

      {error && !dialog && !deleteTarget && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/15 dark:text-red-300">
          {error}
        </p>
      )}

      <ConfirmDialog
        open={dialog !== null}
        title={dialog?.mode === 'rename' ? tFolders('rename') : tFolders('newSubfolder')}
        description={t('folderDialogDescription')}
        confirmLabel={dialog?.mode === 'rename' ? tFolders('renameSave') : tFolders('create')}
        cancelLabel={tCommon('cancel')}
        pending={pending}
        onConfirm={saveFolder}
        onCancel={() => setDialog(null)}
      >
        <div className="flex flex-col gap-3 pt-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="subfolder-name">{t('folderName')}</Label>
            <Input
              id="subfolder-name"
              autoFocus
              value={dialogName}
              maxLength={80}
              placeholder={tFolders('newPlaceholder')}
              disabled={pending}
              onChange={(e) => setDialogName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  saveFolder();
                }
              }}
            />
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium text-foreground">{tFolders('icon')}</legend>
            <div className="grid grid-cols-8 gap-1">
              <IconChoice selected={dialogIcon === null} label={tFolders('noIcon')} onSelect={() => setDialogIcon(null)}>
                <Folder className="size-4" />
              </IconChoice>
              {FOLDER_ICONS.map((icon) => (
                <IconChoice key={icon} selected={dialogIcon === icon} label={icon} onSelect={() => setDialogIcon(icon)}>
                  <span className="text-lg leading-none">{icon}</span>
                </IconChoice>
              ))}
            </div>
          </fieldset>
          {error && dialog && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {error}
            </p>
          )}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={tFolders('deleteConfirm.title')}
        description={tFolders('deleteConfirm.body', { name: deleteTarget?.name ?? '' })}
        confirmLabel={tCommon('delete')}
        cancelLabel={tCommon('cancel')}
        destructive
        pending={pending}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      >
        {error && deleteTarget && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
      </ConfirmDialog>

      {moveTarget && (
        <MoveToFolderDialog
          open
          folders={listing.folders}
          folderId={moveTarget.id}
          pending={pending}
          labels={{
            title: tFolders('moveDialog.title'),
            description: tFolders('moveDialog.description', { name: moveTarget.name }),
            searchPlaceholder: tFolders('moveDialog.search'),
            topLevel: tCommon('topLevel'),
            moveLabel: tFolders('moveDialog.move'),
            cancelLabel: tCommon('cancel'),
            noResults: tCommon('noMatches'),
            empty: tFolders('moveDialog.empty'),
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

function IconChoice({
  selected,
  label,
  onSelect,
  children,
}: {
  selected: boolean;
  label: string;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      title={label}
      onClick={onSelect}
      className={cn(
        'inline-flex size-9 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-2',
        selected && 'bg-accent-50 ring-1 ring-accent-300 dark:bg-accent-500/15',
      )}
    >
      {children}
    </button>
  );
}
