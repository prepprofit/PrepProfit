'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft, CheckCircle2, PackageX, Ban } from 'lucide-react';
import type {
  ProductionCompletionView,
  ProductionLineBase,
} from '@/lib/data/productions';
import type { MeasurementSystem } from '@/lib/db/schema';
import { formatQuantity } from '@/lib/units';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { voidProductionAction } from '@/app/(app)/productions/actions';
import { useActionError } from '@/lib/i18n/use-action-error';

/**
 * Read-only view of a COMPLETED or VOIDED production (Sprint 11b). Renders the FROZEN
 * snapshot — the recipe lines + consumed ingredient quantities at completion, the
 * lifecycle timestamps, and whether stock was moved. Money-free (the manager cost card
 * is a separate server card). A manager may Void a completed run; a voided run is
 * terminal and shows no actions.
 */
export function ProductionCompletedView({
  productionId,
  expectedUpdatedAt,
  label,
  status,
  completion,
  lines,
  notes,
  system,
  canVoid,
}: {
  productionId: string;
  expectedUpdatedAt: string;
  label: string;
  status: 'completed' | 'voided';
  completion: ProductionCompletionView;
  lines: ProductionLineBase[];
  notes: string | null;
  system: MeasurementSystem;
  canVoid: boolean;
}) {
  const t = useTranslations('productions');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();

  const [error, setError] = React.useState<string | null>(null);
  const [voidOpen, setVoidOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  const isVoided = status === 'voided';

  const confirmVoid = () => {
    setError(null);
    startTransition(async () => {
      const result = await voidProductionAction(productionId, {
        expectedUpdatedAt,
      });
      if (result.ok) router.refresh();
      else {
        setError(actionError(result.code));
        setVoidOpen(false);
      }
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/productions"
          className="inline-flex size-9 items-center justify-center rounded-full border border-border bg-surface text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
          aria-label={t('actions.back')}
        >
          <ArrowLeft className="size-4" />
        </Link>
        <h1 className="font-display text-xl font-semibold text-foreground">{label}</h1>
        <Badge variant={isVoided ? 'neutral' : 'positive'}>
          {t(`status.${status}`)}
        </Badge>
        {canVoid && !isVoided && (
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setVoidOpen(true)}
              disabled={pending}
            >
              <Ban className="size-4" />
              {t('actions.void')}
            </Button>
          </div>
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

      <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm">
        <p className="inline-flex items-center gap-2 font-medium text-foreground">
          {isVoided ? (
            <Ban className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <CheckCircle2 className="size-4 shrink-0 text-brand-600 dark:text-brand-400" />
          )}
          {isVoided ? t('completedView.voidedTitle') : t('completedView.completedTitle')}
        </p>
        <p className="text-muted-foreground">
          {isVoided ? t('completedView.voidedBody') : t('completedView.completedBody')}
        </p>
        <p className="text-xs text-muted-foreground">
          {t('completedView.completedAt', {
            time: new Date(completion.completedAt).toLocaleString(),
          })}
          {isVoided && completion.voidedAt
            ? ` · ${t('completedView.voidedAt', {
                time: new Date(completion.voidedAt).toLocaleString(),
              })}`
            : ''}
        </p>
        <p
          className={`inline-flex items-center gap-1.5 text-xs ${
            completion.stockMoved
              ? 'text-muted-foreground'
              : 'text-amber-700 dark:text-amber-300'
          }`}
        >
          {!completion.stockMoved && <PackageX className="size-3.5 shrink-0" />}
          {completion.stockMoved
            ? t('completedView.stockMoved')
            : t('completedView.stockNotMoved')}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('composition.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col divide-y divide-border">
            {lines.map((line) => (
              <li
                key={line.id}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <span className="font-medium text-foreground">{line.recipeName}</span>
                <span className="tabular-nums text-muted-foreground">
                  {t('portions', { count: line.plannedQty })}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('completedView.consumedTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          {completion.consumptions.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {t('completedView.consumedEmpty')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    <th className="pb-2">{t('requirements.ingredient')}</th>
                    <th className="pb-2 text-right">{t('requirements.needed')}</th>
                  </tr>
                </thead>
                <tbody>
                  {completion.consumptions.map((c) => (
                    <tr
                      key={c.ingredientId}
                      className="border-b border-border last:border-0"
                    >
                      <td className="py-2 pr-2 font-medium text-foreground">
                        {c.ingredientName}
                      </td>
                      <td className="py-2 text-right tabular-nums text-foreground">
                        {formatQuantity(c.qtyCanonical, c.dimension, system)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {notes && (
        <Card>
          <CardHeader>
            <CardTitle>{t('fields.notes')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm text-foreground">{notes}</p>
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={voidOpen}
        title={t('voidConfirm.title')}
        description={t('voidConfirm.body', { name: label })}
        confirmLabel={t('actions.void')}
        cancelLabel={tCommon('cancel')}
        pending={pending}
        onConfirm={confirmVoid}
        onCancel={() => setVoidOpen(false)}
      />
    </div>
  );
}
