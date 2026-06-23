'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft, CalendarDays, Lock, Trash2 } from 'lucide-react';
import type { ProductionLineBase } from '@/lib/data/productions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  deleteProductionAction,
  reopenProductionAction,
} from '@/app/(app)/productions/actions';
import { useActionError } from '@/lib/i18n/use-action-error';

/**
 * Read-only view of a PLANNED production (Sprint 11a). The plan is locked: to change
 * recipes/portions/date the user must explicitly Reopen it to draft. Money-free
 * (composition + date + notes only); the manager cost card is a separate server card.
 * Reopen + Delete carry `expectedUpdatedAt` for optimistic concurrency.
 */
export function ProductionPlannedView({
  productionId,
  expectedUpdatedAt,
  label,
  plannedFor,
  notes,
  lines,
}: {
  productionId: string;
  expectedUpdatedAt: string;
  label: string;
  plannedFor: string | null;
  notes: string | null;
  lines: ProductionLineBase[];
}) {
  const t = useTranslations('productions');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();

  const [error, setError] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  const onReopen = () => {
    setError(null);
    startTransition(async () => {
      const result = await reopenProductionAction(productionId, {
        expectedUpdatedAt,
      });
      if (result.ok) router.refresh();
      else setError(actionError(result.code));
    });
  };

  const confirmDelete = () => {
    setError(null);
    startTransition(async () => {
      const result = await deleteProductionAction(productionId, {
        expectedUpdatedAt,
      });
      if (result.ok) router.push('/productions');
      else {
        setError(actionError(result.code));
        setConfirmOpen(false);
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
        <Badge variant="accent">{t('status.planned')}</Badge>
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" onClick={onReopen} disabled={pending}>
            {t('actions.reopen')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirmOpen(true)}
            disabled={pending}
            aria-label={t('actions.delete')}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      )}

      <p
        role="status"
        className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-4 py-2 text-sm text-muted-foreground"
      >
        <Lock className="size-4 shrink-0" />
        {t('plannedView.body')}
      </p>

      <Card>
        <CardHeader>
          <CardTitle>{t('composition.title')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {plannedFor && (
            <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              <CalendarDays className="size-4" />
              {plannedFor}
            </p>
          )}
          <ul className="flex flex-col divide-y divide-border">
            {lines.map((line) => (
              <li
                key={line.id}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <span className="flex items-center gap-2">
                  <span className="font-medium text-foreground">
                    {line.recipeName}
                  </span>
                  {!line.available && (
                    <Badge variant="warning">{t('unavailableLine')}</Badge>
                  )}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {t('portions', { count: line.plannedQty })}
                </span>
              </li>
            ))}
          </ul>
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
        open={confirmOpen}
        title={t('deleteConfirm.title')}
        description={t('deleteConfirm.body', { name: label })}
        confirmLabel={tCommon('moveToTrash')}
        cancelLabel={tCommon('cancel')}
        pending={pending}
        onConfirm={confirmDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
