'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  purgeIngredientAction,
  purgeRecipeAction,
  restoreIngredientAction,
  restoreRecipeAction,
} from '@/app/(app)/trash/actions';
import { useActionError } from '@/lib/i18n/use-action-error';

export type TrashItem = { id: string; name: string; daysLeft: number };
type Kind = 'recipe' | 'ingredient';

/** Below this many days left, the countdown badge turns amber. */
const SOON_THRESHOLD_DAYS = 7;

export function TrashView({
  recipes,
  ingredients,
}: {
  recipes: TrashItem[];
  ingredients: TrashItem[];
}) {
  const t = useTranslations('trash');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [purgeTarget, setPurgeTarget] = React.useState<{
    kind: Kind;
    item: TrashItem;
  } | null>(null);
  const [pending, startTransition] = React.useTransition();

  const isEmpty = recipes.length === 0 && ingredients.length === 0;

  const restore = (kind: Kind, id: string) => {
    setError(null);
    startTransition(async () => {
      const result =
        kind === 'recipe'
          ? await restoreRecipeAction(id)
          : await restoreIngredientAction(id);
      if (result.ok) router.refresh();
      else setError(actionError(result.code));
    });
  };

  const confirmPurge = () => {
    if (!purgeTarget) return;
    const { kind, item } = purgeTarget;
    setError(null);
    startTransition(async () => {
      const result =
        kind === 'recipe'
          ? await purgeRecipeAction(item.id)
          : await purgeIngredientAction(item.id);
      if (result.ok) router.refresh();
      else setError(actionError(result.code));
      setPurgeTarget(null);
    });
  };

  if (isEmpty) {
    return (
      <p className="rounded-xl border border-dashed border-border bg-surface px-4 py-12 text-center text-sm text-muted-foreground">
        {t('empty')}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      )}

      <Section
        title={t('sections.recipes')}
        items={recipes}
        kind="recipe"
        pending={pending}
        onRestore={restore}
        onPurge={(item) => setPurgeTarget({ kind: 'recipe', item })}
        labelFor={(n) => (n === 0 ? t('expiresToday') : t('daysLeft', { days: n }))}
        restoreLabel={t('restore')}
        deleteLabel={t('deleteForever')}
      />
      <Section
        title={t('sections.ingredients')}
        items={ingredients}
        kind="ingredient"
        pending={pending}
        onRestore={restore}
        onPurge={(item) => setPurgeTarget({ kind: 'ingredient', item })}
        labelFor={(n) => (n === 0 ? t('expiresToday') : t('daysLeft', { days: n }))}
        restoreLabel={t('restore')}
        deleteLabel={t('deleteForever')}
      />

      <ConfirmDialog
        open={purgeTarget !== null}
        title={t('purgeConfirm.title')}
        description={t('purgeConfirm.body', { name: purgeTarget?.item.name ?? '' })}
        confirmLabel={tCommon('deleteForever')}
        cancelLabel={tCommon('cancel')}
        destructive
        pending={pending}
        onConfirm={confirmPurge}
        onCancel={() => setPurgeTarget(null)}
      />
    </div>
  );
}

function Section({
  title,
  items,
  kind,
  pending,
  onRestore,
  onPurge,
  labelFor,
  restoreLabel,
  deleteLabel,
}: {
  title: string;
  items: TrashItem[];
  kind: Kind;
  pending: boolean;
  onRestore: (kind: Kind, id: string) => void;
  onPurge: (item: TrashItem) => void;
  labelFor: (daysLeft: number) => string;
  restoreLabel: string;
  deleteLabel: string;
}) {
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-3"
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className="truncate font-medium text-foreground">
                {item.name}
              </span>
              <Badge variant={item.daysLeft <= SOON_THRESHOLD_DAYS ? 'warning' : 'neutral'}>
                {labelFor(item.daysLeft)}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => onRestore(kind, item.id)}
              >
                <RotateCcw className="size-4" />
                {restoreLabel}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={deleteLabel}
                disabled={pending}
                onClick={() => onPurge(item)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
