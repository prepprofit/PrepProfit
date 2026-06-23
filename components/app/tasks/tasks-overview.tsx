'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CalendarDays, Copy, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  createTaskListAction,
  deleteTaskListAction,
  duplicateTaskListAction,
} from '@/app/(app)/tasks/actions';
import { useActionError } from '@/lib/i18n/use-action-error';

type GroupKey = 'today' | 'upcoming' | 'noDate';

export type OverviewList = {
  id: string;
  name: string;
  scheduledFor: string | null;
  updatedAt: string;
  done: number;
  total: number;
  group: GroupKey;
};

const GROUP_ORDER: GroupKey[] = ['today', 'upcoming', 'noDate'];

/** Money-free task-list overview (Sprint 6). Both roles; manager gets list lifecycle. */
export function TasksOverview({
  lists,
  canManage,
}: {
  lists: OverviewList[];
  canManage: boolean;
}) {
  const t = useTranslations('tasks');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [newDate, setNewDate] = React.useState('');
  const [deleteTarget, setDeleteTarget] = React.useState<OverviewList | null>(null);
  const [pending, startTransition] = React.useTransition();

  const run = (fn: () => Promise<{ ok: boolean; code?: string }>, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        after?.();
        router.refresh();
      } else if ('code' in result && result.code) {
        setError(actionError(result.code as Parameters<typeof actionError>[0]));
      }
    });
  };

  const submitCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (newName.trim() === '') return;
    run(
      () =>
        createTaskListAction({
          name: newName,
          scheduledFor: newDate === '' ? null : newDate,
        }),
      () => {
        setCreating(false);
        setNewName('');
        setNewDate('');
      },
    );
  };

  const grouped = GROUP_ORDER.map((key) => ({
    key,
    items: lists.filter((l) => l.group === key),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        {canManage && !creating && (
          <Button type="button" onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            {t('new')}
          </Button>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {canManage && creating && (
        <Card>
          <CardContent className="p-4">
            <form onSubmit={submitCreate} className="flex flex-wrap items-end gap-3">
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('listName')}
                </span>
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={t('listNamePlaceholder')}
                  maxLength={200}
                  autoFocus
                  required
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('date')}
                </span>
                <Input
                  type="date"
                  value={newDate}
                  onChange={(e) => setNewDate(e.target.value)}
                />
              </label>
              <div className="flex items-center gap-2">
                <Button type="submit" disabled={pending || newName.trim() === ''}>
                  {t('create')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    setCreating(false);
                    setNewName('');
                    setNewDate('');
                  }}
                >
                  {tCommon('cancel')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {lists.length === 0 && !creating ? (
        <p className="rounded-xl border border-dashed border-border bg-surface px-4 py-12 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        grouped.map((group) => (
          <section key={group.key} className="flex flex-col gap-2">
            <h2 className="px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {t(`groups.${group.key}`)}
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {group.items.map((list) => (
                <Card key={list.id} className="transition-colors hover:border-accent-300">
                  <CardContent className="flex flex-col gap-3 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        href={`/tasks/${list.id}`}
                        className="font-display text-base font-semibold text-foreground hover:text-accent-700"
                      >
                        {list.name}
                      </Link>
                      {list.scheduledFor && (
                        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                          <CalendarDays className="size-3.5" />
                          {list.scheduledFor}
                        </span>
                      )}
                    </div>

                    <ProgressBar done={list.done} total={list.total} label={t('progress', { done: list.done, total: list.total })} />

                    {canManage && (
                      <div className="flex items-center gap-1.5">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          onClick={() =>
                            run(() =>
                              duplicateTaskListAction(
                                list.id,
                                `${list.name} ${t('duplicateSuffix')}`,
                              ),
                            )
                          }
                        >
                          <Copy className="size-4" />
                          {t('duplicate')}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={t('deleteList')}
                          disabled={pending}
                          onClick={() => setDeleteTarget(list)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        ))
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('deleteListConfirm.title')}
        description={t('deleteListConfirm.body', { name: deleteTarget?.name ?? '' })}
        confirmLabel={t('deleteList')}
        cancelLabel={tCommon('cancel')}
        destructive
        pending={pending}
        onConfirm={() => {
          const target = deleteTarget;
          if (!target) return;
          setDeleteTarget(null);
          run(() =>
            deleteTaskListAction(target.id, { expectedUpdatedAt: target.updatedAt }),
          );
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function ProgressBar({
  done,
  total,
  label,
}: {
  done: number;
  total: number;
  label: string;
}) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const allDone = total > 0 && done === total;
  return (
    <div className="flex flex-col gap-1">
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className={allDone ? 'h-full bg-emerald-600' : 'h-full bg-accent-600'}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">{label}</span>
    </div>
  );
}
