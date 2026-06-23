'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Check, ListPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import {
  createPrepTaskFromRecipeAction,
  createReorderTaskFromIngredientAction,
  taskListOptionsAction,
} from '@/app/(app)/tasks/actions';
import { useActionError } from '@/lib/i18n/use-action-error';
import type { ActionErrorCode } from '@/lib/action-result';
import type { TaskListOption } from '@/lib/data/tasks';

/**
 * A small money-free affordance that appends a data-anchored task to a chosen list
 * (Sprint 6 D7): a PREP task from a recipe, or a REORDER task from a low-stock
 * ingredient. Lists are fetched lazily on open (active lists only). The picker is
 * self-contained so it can drop into the recipe editor, the low-stock panel or the
 * ingredients page without prop-drilling the list set.
 */
export function AddToTaskListMenu({
  kind,
  sourceId,
}: {
  kind: 'prep' | 'reorder';
  sourceId: string;
}) {
  const t = useTranslations('tasks.integration');
  const actionError = useActionError();
  const [open, setOpen] = React.useState(false);
  const [options, setOptions] = React.useState<TaskListOption[] | null>(null);
  const [listId, setListId] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  const openMenu = () => {
    setOpen(true);
    setError(null);
    setDone(false);
    if (options === null) {
      startTransition(async () => {
        const lists = await taskListOptionsAction();
        setOptions(lists);
        setListId(lists[0]?.id ?? '');
      });
    }
  };

  const submit = () => {
    if (listId === '') return;
    setError(null);
    startTransition(async () => {
      const result =
        kind === 'prep'
          ? await createPrepTaskFromRecipeAction({ listId, recipeId: sourceId })
          : await createReorderTaskFromIngredientAction({
              listId,
              ingredientId: sourceId,
            });
      if (result.ok) {
        setDone(true);
        setOpen(false);
      } else {
        setError(actionError(result.code as ActionErrorCode));
      }
    });
  };

  const label = kind === 'prep' ? t('addPrepTask') : t('createReorderTask');

  if (!open) {
    return (
      <div className="flex flex-col gap-1">
        <Button type="button" variant="outline" size="sm" onClick={openMenu}>
          {done ? <Check className="size-4" /> : <ListPlus className="size-4" />}
          {done ? t('added') : label}
        </Button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    );
  }

  const noLists = options !== null && options.length === 0;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-2">
      {noLists ? (
        <p className="text-xs text-muted-foreground">{t('noLists')}</p>
      ) : (
        <div className="flex items-center gap-2">
          <Select
            aria-label={t('chooseList')}
            className="h-8 w-48"
            value={listId}
            disabled={pending || options === null}
            onChange={(e) => setListId(e.target.value)}
          >
            {(options ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            size="sm"
            disabled={pending || listId === ''}
            onClick={submit}
          >
            {t('add')}
          </Button>
        </div>
      )}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
