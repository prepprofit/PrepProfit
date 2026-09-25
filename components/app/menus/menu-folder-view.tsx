'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { ChevronRight, Folder, FolderPlus, Move, Pencil, Plus, Trash2 } from 'lucide-react';
import type { DishListItem, ManagerDishListItem, MenuFolderSummary } from '@/lib/data/menus';
import { DISH_SORTS, type DishSort } from '@/lib/validation/menus';
import { folderChildren, folderPath } from '@/lib/folders/tree';
import { formatMoney } from '@/lib/format/money';
import { useActionError } from '@/lib/i18n/use-action-error';
import {
  createMenuFolderAction,
  deleteMenuFolderAction,
  moveMenuFolderAction,
  renameMenuFolderAction,
} from '@/app/(app)/menus/actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Toast } from '@/components/ui/toast';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { FolderTile } from '@/components/app/shared/folders/folder-tile';
import { FolderMenu } from '@/components/app/shared/folders/folder-menu';
import { FolderBreadcrumb, type BreadcrumbCrumb } from '@/components/app/shared/folders/folder-breadcrumb';
import { MoveToFolderDialog } from '@/components/app/shared/folders/move-to-folder-dialog';
import { useFolderDragAndDrop } from '@/components/app/shared/folders/use-folder-drag';
import { formatPercentBps, marginVariant, numberToField } from './dish-format';

type Notice = { message: string; undo: (() => void) | null; isError?: boolean };

type Props = {
  /** null = the "Unfiled" pseudo-folder (no parent chain, no subfolders). */
  folder: { id: string; name: string; parentId: string | null } | null;
  /** The full org folder list — powers the breadcrumb, subfolder tiles, and "Move to…". */
  folders: MenuFolderSummary[];
  sort: DishSort;
  truncated: boolean;
} & (
  | { canManage: true; dishes: ManagerDishListItem[]; currency: string }
  | { canManage: false; dishes: DishListItem[] }
);

/**
 * One folder's dishes (Menu redesign), now with its immediate subfolders shown
 * above the dish list, a breadcrumb trail, and a "Move to…" action alongside
 * rename/delete. Managers also see cost, price and margin per portion; kitchen
 * rows carry no money by type. Sort is a URL param so the server orders in SQL.
 */
export function MenuFolderView(props: Props) {
  const { folder, folders, sort, truncated } = props;
  const t = useTranslations('menus.folder');
  const tHome = useTranslations('menus.home');
  const tBatch = useTranslations('menus.batch');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const router = useRouter();
  const actionError = useActionError();

  const [renaming, setRenaming] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [creatingSub, setCreatingSub] = React.useState(false);
  const [subfolderName, setSubfolderName] = React.useState('');
  const [moving, setMoving] = React.useState(false);
  const [moveTarget, setMoveTarget] = React.useState<{ id: string; name: string } | null>(null);
  const [name, setName] = React.useState(folder?.name ?? '');
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.undo ? 8000 : 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const title = folder?.name ?? t('unfiled');
  const newDishHref = folder ? `/menus/new?folder=${folder.id}` : '/menus/new';
  const children = React.useMemo(
    () => (folder ? folderChildren(folders, folder.id) : []),
    [folders, folder],
  );
  const crumbs: BreadcrumbCrumb[] = folder
    ? [
        { key: 'root', label: t('back'), href: '/menus' },
        ...folderPath(folders, folder.id).map((f) => ({
          key: f.id,
          label: f.name,
          href: `/menus/folders/${f.id}`,
        })),
      ]
    : [];

  function rename() {
    if (!folder || !name.trim()) return;
    setError(null);
    startTransition(async () => {
      const result = await renameMenuFolderAction(folder.id, { name: name.trim() });
      if (!result.ok) return setError(actionError(result.code));
      setRenaming(false);
      router.refresh();
    });
  }

  function remove() {
    if (!folder) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteMenuFolderAction(folder.id);
      if (!result.ok) return setError(actionError(result.code));
      router.push('/menus');
    });
  }

  function createSubfolder() {
    if (!folder || !subfolderName.trim()) return;
    setError(null);
    startTransition(async () => {
      const result = await createMenuFolderAction({ name: subfolderName.trim() }, folder.id);
      if (!result.ok) return setError(actionError(result.code));
      setCreatingSub(false);
      setSubfolderName('');
      router.push(`/menus/folders/${result.data.id}`);
    });
  }

  function performMove(id: string, newParentId: string | null) {
    const target = folders.find((f) => f.id === id);
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
          ? t('moved', { name: target?.name ?? '', parent: destination })
          : t('movedTopLevel', { name: target?.name ?? '' }),
        undo: () => performMove(id, previousParentId),
      });
      router.refresh();
    });
  }

  const drag = useFolderDragAndDrop({
    folders,
    onMove: (id, newParentId) => performMove(id, newParentId),
    disabled: !props.canManage,
  });

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <div className="flex flex-col gap-3">
        {folder ? (
          <FolderBreadcrumb crumbs={crumbs} />
        ) : (
          <Link
            href="/menus"
            className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            {t('back')}
          </Link>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              {title}
            </h2>
            {props.canManage && folder && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('rename')}
                  title={t('rename')}
                  onClick={() => {
                    setName(folder.name);
                    setError(null);
                    setRenaming(true);
                  }}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('moveToFolder')}
                  title={t('moveToFolder')}
                  onClick={() => {
                    setError(null);
                    setMoving(true);
                  }}
                >
                  <Move />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('delete')}
                  title={t('delete')}
                  onClick={() => {
                    setError(null);
                    setDeleting(true);
                  }}
                >
                  <Trash2 />
                </Button>
              </>
            )}
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <label className="sr-only" htmlFor="dish-sort">
              {t('sortLabel')}
            </label>
            <div className="min-w-0 flex-1 sm:w-48 sm:flex-none">
              <Select
                id="dish-sort"
                value={sort}
                onChange={(e) => {
                  const next = e.target.value as DishSort;
                  router.replace(next === 'modified' ? '?' : `?sort=${next}`);
                }}
              >
                {DISH_SORTS.map((key) => (
                  <option key={key} value={key}>
                    {t(`sort.${key}`)}
                  </option>
                ))}
              </Select>
            </div>
            {props.canManage && (
              <Button asChild>
                <Link href={newDishHref}>
                  <Plus />
                  {t('newDish')}
                </Link>
              </Button>
            )}
          </div>
        </div>
      </div>

      {folder && (children.length > 0 || props.canManage) && (
        <section aria-label={t('subfolders')} className="flex flex-col gap-2">
          {children.length > 0 && (
            <h3 className="px-1 text-xs font-medium text-muted-foreground">{t('subfolders')}</h3>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {children.map((child) => (
              <div key={child.id} className="relative focus-within:z-30">
                <FolderTile
                  href={`/menus/folders/${child.id}`}
                  name={child.name}
                  caption={tHome('dishCount', { count: child.dishCount })}
                  icon={<Folder className="size-5" aria-hidden />}
                  dragProps={props.canManage ? drag.getTileProps(child.id) : undefined}
                  isDragSource={drag.draggingId === child.id}
                  dropState={drag.overId === child.id ? (drag.committing ? 'commit' : 'candidate') : null}
                />
                {props.canManage && (
                  <FolderMenu
                    label={tHome('folderActions', { name: child.name })}
                    disabled={pending}
                    items={[
                      {
                        label: t('moveToFolder'),
                        icon: <Move className="size-4" />,
                        onSelect: () => setMoveTarget({ id: child.id, name: child.name }),
                      },
                    ]}
                  />
                )}
              </div>
            ))}
            {props.canManage && (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setSubfolderName('');
                  setCreatingSub(true);
                }}
                className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground transition-colors hover:border-accent-300 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <FolderPlus className="size-5" aria-hidden />
                {t('newSubfolder')}
              </button>
            )}
          </div>
        </section>
      )}

      {props.dishes.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          {props.canManage ? t('emptyManager') : t('emptyKitchen')}
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
          {props.dishes.map((dish) => {
            const date =
              sort === 'opened'
                ? dish.lastOpenedAt
                : sort === 'created'
                  ? dish.createdAt
                  : dish.updatedAt;
            const dateLabel =
              date === null
                ? t('neverOpened')
                : t(`dateLabel.${sort === 'name' ? 'modified' : sort}`, {
                    date: format.dateTime(date, { dateStyle: 'medium' }),
                  });
            const money = props.canManage ? (dish as ManagerDishListItem) : null;
            return (
              <li key={dish.id}>
                <Link
                  href={`/menus/${dish.id}`}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate font-medium text-foreground">{dish.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {t('meta', {
                        components: dish.componentCount,
                        batch: tBatch('makes', {
                          unit: dish.output.unit,
                          count: dish.output.quantity,
                          amount: numberToField(dish.output.quantity),
                        }),
                      })}
                      {' · '}
                      {dateLabel}
                    </span>
                  </div>
                  {money && props.canManage && (
                    <div className="flex shrink-0 flex-col items-end gap-1 text-right sm:flex-row sm:items-center sm:gap-4">
                      <span className="hidden text-xs text-muted-foreground sm:inline">
                        {t('costShort')}{' '}
                        <span className="tabular-nums text-foreground">
                          {money.costPerSaleUnitCents !== null
                            ? `${formatMoney(money.costPerSaleUnitCents, props.currency)} ${tBatch(`per.${money.priceBasis === 'kg' ? 'kg' : dish.output.unit}`)}`
                            : '—'}
                        </span>
                      </span>
                      <span className="text-sm font-medium tabular-nums text-foreground">
                        {money.sellingPriceCents !== null
                          ? `${formatMoney(money.sellingPriceCents, props.currency)} ${tBatch(`per.${money.priceBasis === 'kg' ? 'kg' : dish.output.unit}`)}`
                          : t('noPrice')}
                      </span>
                      <Badge variant={marginVariant(money.marginBps)} className="tabular-nums">
                        {money.marginBps !== null ? formatPercentBps(money.marginBps) : '—'}
                      </Badge>
                    </div>
                  )}
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {truncated && <p className="text-xs text-muted-foreground">{t('truncated')}</p>}

      <ConfirmDialog
        open={renaming}
        title={t('rename')}
        description={t('renameDescription')}
        confirmLabel={t('save')}
        cancelLabel={t('cancel')}
        pending={pending}
        onConfirm={rename}
        onCancel={() => setRenaming(false)}
      >
        <Input
          value={name}
          maxLength={80}
          autoFocus
          aria-label={t('rename')}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              rename();
            }
          }}
        />
        {error && renaming && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting}
        title={t('deleteTitle')}
        description={t('deleteBody', { name: title })}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        destructive
        pending={pending}
        onConfirm={remove}
        onCancel={() => setDeleting(false)}
      >
        {error && deleting && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={creatingSub}
        title={t('newSubfolder')}
        description={t('renameDescription')}
        confirmLabel={tHome('create')}
        cancelLabel={t('cancel')}
        pending={pending}
        onConfirm={createSubfolder}
        onCancel={() => setCreatingSub(false)}
      >
        <Input
          value={subfolderName}
          maxLength={80}
          autoFocus
          placeholder={tHome('folderNamePlaceholder')}
          aria-label={tHome('folderName')}
          onChange={(e) => setSubfolderName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              createSubfolder();
            }
          }}
        />
        {error && creatingSub && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
      </ConfirmDialog>

      {(moving || moveTarget) && folder && (
        <MoveToFolderDialog
          open
          folders={folders}
          folderId={moveTarget?.id ?? folder.id}
          pending={pending}
          labels={{
            title: t('moveDialog.title'),
            description: t('moveDialog.description', { name: moveTarget?.name ?? folder.name }),
            searchPlaceholder: t('moveDialog.search'),
            topLevel: tCommon('topLevel'),
            moveLabel: t('moveDialog.move'),
            cancelLabel: tCommon('cancel'),
            noResults: tCommon('noMatches'),
            empty: t('moveDialog.empty'),
          }}
          onMove={(newParentId) => {
            performMove(moveTarget?.id ?? folder.id, newParentId);
            setMoving(false);
            setMoveTarget(null);
          }}
          onCancel={() => {
            setMoving(false);
            setMoveTarget(null);
          }}
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
