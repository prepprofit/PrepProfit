'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Folder, Move, Pencil, Trash2 } from 'lucide-react';
import type { FolderListing, FolderWithCount } from '@/lib/data/recipe-folders';
import { FOLDER_ICONS } from '@/lib/validation/recipe-folders';
import { useActionError } from '@/lib/i18n/use-action-error';
import {
  createFolderAction,
  deleteFolderAction,
  moveFolderAction,
  moveRecipeToFolderAction,
  renameFolderAction,
  reorderFolderAction,
} from '@/app/(app)/recipes/folder-actions';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Toast } from '@/components/ui/toast';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MoveToFolderDialog } from '@/components/app/shared/folders/move-to-folder-dialog';
import { useFolderDragAndDrop } from '@/components/app/shared/folders/use-folder-drag';
import type { FolderMenuItem } from '@/components/app/shared/folders/folder-menu';
import { cn } from '@/lib/utils';

type FolderDialog =
  | { mode: 'create' }
  | { mode: 'rename'; id: string; name: string; icon: string | null };

type Notice = { message: string; undo: (() => void) | null; isError?: boolean };

/**
 * The folder-management state machine shared by the Recipes landing page and the
 * in-folder view (previously duplicated almost line for line between
 * recipe-home.tsx and recipe-subfolders.tsx): create / rename / reorder / delete,
 * "Move to…" for BOTH a folder and a recipe, drag-and-drop, and the toast with
 * Undo.
 *
 * Every mutation goes through the existing validated Server Actions — there is
 * no client-side bypass, and nothing is recreated client-side. The UI is NOT
 * optimistic: the server re-renders after `router.refresh()`, so a rejected move
 * simply leaves the current arrangement in place and shows the mapped error.
 */
export function useFolderAdmin({
  listing,
  parentId,
  recipeName,
}: {
  listing: FolderListing;
  /** Where "New folder" creates — null on the landing page, the open folder inside one. */
  parentId: string | null;
  /** Resolves a recipe id to its name for the move toast (drag drops know only the id). */
  recipeName?: (id: string) => string | undefined;
}) {
  const t = useTranslations('recipes.home');
  const tFolders = useTranslations('recipes.folders');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();

  const [dialog, setDialog] = React.useState<FolderDialog | null>(null);
  const [dialogName, setDialogName] = React.useState('');
  const [dialogIcon, setDialogIcon] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<{ id: string; name: string } | null>(null);
  const [moveTarget, setMoveTarget] = React.useState<{ id: string; name: string } | null>(null);
  const [recipeMoveTarget, setRecipeMoveTarget] = React.useState<{ id: string; name: string } | null>(null);
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

  /** Reparents a folder, then offers Undo (which re-runs the same validated action). */
  const performMove = React.useCallback(
    (id: string, newParentId: string | null) => {
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
    },
    [actionError, listing.folders, router, tFolders],
  );

  /** Files a recipe, then offers Undo back to the folder it came from. */
  const performRecipeMove = React.useCallback(
    (recipeId: string, folderId: string | null, previousFolderId?: string | null, name?: string) => {
      const label = name ?? recipeName?.(recipeId) ?? '';
      startTransition(async () => {
        const result = await moveRecipeToFolderAction(recipeId, { folderId });
        if (!result.ok) {
          setNotice({ message: actionError(result.code), undo: null, isError: true });
          return;
        }
        const destination = folderId ? listing.folders.find((f) => f.id === folderId)?.name : null;
        setNotice({
          message: destination
            ? tFolders('recipeMoved', { name: label, parent: destination })
            : tFolders('recipeMovedUnfiled', { name: label }),
          undo:
            previousFolderId === undefined
              ? null
              : () => performRecipeMove(recipeId, previousFolderId, folderId, label),
        });
        router.refresh();
      });
    },
    [actionError, listing.folders, recipeName, router, tFolders],
  );

  const drag = useFolderDragAndDrop({
    folders: listing.folders,
    onMove: performMove,
    onMoveRecipe: (recipeId, folderId) => performRecipeMove(recipeId, folderId),
  });

  /** The "⋯" menu entries for one folder tile within its sibling rail. */
  function menuItemsFor(folder: FolderWithCount, index: number, siblingCount: number): FolderMenuItem[] {
    return [
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
        disabled: index === siblingCount - 1,
        onSelect: () => reorder(folder.id, 'down'),
      },
      {
        label: tFolders('delete'),
        icon: <Trash2 className="size-4" />,
        destructive: true,
        onSelect: () => setDeleteTarget({ id: folder.id, name: folder.name }),
      },
    ];
  }

  /** "Move “Linda” into “Wibox”" — shown while a drag hovers a valid target, before release. */
  const dragHint = React.useMemo(() => {
    if (!drag.dragging || drag.overId === null) return null;
    const source =
      drag.dragging.kind === 'folder'
        ? (listing.folders.find((f) => f.id === drag.dragging?.id)?.name ?? '')
        : (recipeName?.(drag.dragging.id) ?? '');
    const target = listing.folders.find((f) => f.id === drag.overId)?.name ?? null;
    return target
      ? t('dragHint', { name: source, parent: target })
      : t('dragHintTopLevel', { name: source });
  }, [drag.dragging, drag.overId, listing.folders, recipeName, t]);

  const dialogs = (
    <>
      <ConfirmDialog
        open={dialog !== null}
        title={dialog?.mode === 'rename' ? tFolders('rename') : parentId === null ? t('newFolder') : tFolders('newSubfolder')}
        description={t('folderDialogDescription')}
        confirmLabel={dialog?.mode === 'rename' ? tFolders('renameSave') : tFolders('create')}
        cancelLabel={tCommon('cancel')}
        pending={pending}
        onConfirm={saveFolder}
        onCancel={() => setDialog(null)}
      >
        <div className="flex flex-col gap-3 pt-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="folder-admin-name">{t('folderName')}</Label>
            <Input
              id="folder-admin-name"
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

      {recipeMoveTarget && (
        <MoveToFolderDialog
          open
          folders={listing.folders}
          folderId={null}
          pending={pending}
          labels={{
            title: tFolders('moveRecipeDialog.title'),
            description: tFolders('moveRecipeDialog.description', { name: recipeMoveTarget.name }),
            searchPlaceholder: tFolders('moveDialog.search'),
            topLevel: tFolders('noFolder'),
            moveLabel: tFolders('moveDialog.move'),
            cancelLabel: tCommon('cancel'),
            noResults: tCommon('noMatches'),
            empty: tFolders('moveRecipeDialog.empty'),
          }}
          onMove={(folderId) => {
            performRecipeMove(recipeMoveTarget.id, folderId, undefined, recipeMoveTarget.name);
            setRecipeMoveTarget(null);
          }}
          onCancel={() => setRecipeMoveTarget(null)}
        />
      )}

      {dragHint && (
        <div
          role="status"
          className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-border bg-surface px-4 py-2 text-sm text-foreground shadow-lg"
        >
          {dragHint}
        </div>
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
    </>
  );

  return {
    drag,
    pending,
    error: dialog === null && deleteTarget === null ? error : null,
    openCreate: () => openDialog({ mode: 'create' }),
    openRecipeMove: (recipe: { id: string; name: string }) => setRecipeMoveTarget(recipe),
    menuItemsFor,
    dialogs,
  };
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
