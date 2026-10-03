'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { formatMoney } from '@/lib/format/money';
import { useActionError } from '@/lib/i18n/use-action-error';
import { clearLegacyRecipeCostsAction } from '@/app/(app)/recipes/[id]/workspace-actions';
import type { WorkspaceCostView } from './recipe-workspace-tabs';

/**
 * MANAGER-ONLY recipe cost: cost per batch (scaled by the view's factor) and cost
 * per kg of finished weight — "—" with a reason whenever a price or the finished
 * weight is missing, never a partial total presented as complete. Labour/energy left
 * by the retired editor stay visible here until removed.
 */
export function RecipeCostSummary({
  recipeId,
  cost,
  currency,
  factor = 1,
}: {
  recipeId: string;
  cost: NonNullable<WorkspaceCostView>;
  currency: string;
  factor?: number;
}) {
  const t = useTranslations('recipes.workspace.costSummary');
  const actionError = useActionError();
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const clearLegacy = () => {
    const { labourCents, energyCents } = cost.legacy;
    startTransition(async () => {
      const result = await clearLegacyRecipeCostsAction(recipeId, { labour: labourCents > 0, energy: energyCents > 0 });
      if (!result.ok) setError(actionError(result.code));
      else router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-border px-4 py-3">
          <dt className="text-xs text-muted-foreground">
            {factor === 1 ? t('batch') : t('batchScaled', { factor: Math.round(factor * 100) / 100 })}
          </dt>
          <dd className="font-display text-2xl font-semibold tabular-nums">
            {cost.complete ? formatMoney(Math.round(cost.batchCostCents * factor), currency) : '—'}
          </dd>
        </div>
        <div className="rounded-xl border border-border px-4 py-3">
          <dt className="text-xs text-muted-foreground">{t('perKg')}</dt>
          <dd className="font-display text-2xl font-semibold tabular-nums">
            {cost.complete && cost.costPerKgCents !== null ? formatMoney(cost.costPerKgCents, currency) : '—'}
          </dd>
        </div>
      </dl>
      {!cost.complete ? (
        <p className="text-sm text-amber-700 dark:text-amber-300">{t('incomplete')}</p>
      ) : cost.costPerKgCents === null ? (
        <p className="text-sm text-muted-foreground">{t('needsWeight')}</p>
      ) : null}
      {cost.legacy.labourCents > 0 || cost.legacy.energyCents > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">
          <span>
            {t('legacy', {
              labour: formatMoney(cost.legacy.labourCents, currency),
              energy: formatMoney(cost.legacy.energyCents, currency),
            })}
          </span>
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={clearLegacy}>
            {t('legacyRemove')}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
