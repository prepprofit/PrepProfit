'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { ArrowLeft, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';
import type { DishListItem, ManagerDishListItem } from '@/lib/data/menus';
import { DISH_SORTS, type DishSort } from '@/lib/validation/menus';
import { formatMoney } from '@/lib/format/money';
import { useActionError } from '@/lib/i18n/use-action-error';
import { deleteMenuFolderAction, renameMenuFolderAction } from '@/app/(app)/menus/actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { formatPercentBps, marginVariant } from './dish-format';

type Props = {
  /** null = the "Unfiled" pseudo-folder. */
  folder: { id: string; name: string } | null;
  sort: DishSort;
  truncated: boolean;
} & (
  | { canManage: true; dishes: ManagerDishListItem[]; currency: string }
  | { canManage: false; dishes: DishListItem[] }
);

/**
 * One folder's dishes as a clean list (Menu redesign). Sort is a URL param so the
 * server orders in SQL and a link restores the same view. Managers also see cost,
 * price and margin per portion; kitchen rows carry no money by type.
 */
export function MenuFolderView(props: Props) {
  const { folder, sort, truncated } = props;
  const t = useTranslations('menus.folder');
  const format = useFormatter();
  const router = useRouter();
  const actionError = useActionError();

  const [renaming, setRenaming] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [name, setName] = React.useState(folder?.name ?? '');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const title = folder?.name ?? t('unfiled');
  const newDishHref = folder ? `/menus/new?folder=${folder.id}` : '/menus/new';

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

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <div className="flex flex-col gap-3">
        <Link
          href="/menus"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {t('back')}
        </Link>
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
                      {t('meta', { components: dish.componentCount, portions: dish.portions })}
                      {' · '}
                      {dateLabel}
                    </span>
                  </div>
                  {money && props.canManage && (
                    <div className="flex shrink-0 flex-col items-end gap-1 text-right sm:flex-row sm:items-center sm:gap-4">
                      <span className="hidden text-xs text-muted-foreground sm:inline">
                        {t('costShort')}{' '}
                        <span className="tabular-nums text-foreground">
                          {money.costPerPortionCents !== null
                            ? formatMoney(money.costPerPortionCents, props.currency)
                            : '—'}
                        </span>
                      </span>
                      <span className="text-sm font-medium tabular-nums text-foreground">
                        {money.sellingPriceCents !== null
                          ? formatMoney(money.sellingPriceCents, props.currency)
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
    </div>
  );
}
