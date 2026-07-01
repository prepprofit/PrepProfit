'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Ban, PackageMinus } from 'lucide-react';
import type { SaleDetail } from '@/lib/data/sales';
import { formatMoney } from '@/lib/format/money';
import { bpsToPercent } from '@/lib/calculations/tax';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DailyCloseSummaryCard } from '@/components/app/sales/daily-close-summary-card';
import { voidSaleAction } from '@/app/(app)/sales/actions';
import { useActionError } from '@/lib/i18n/use-action-error';

/**
 * Read-only view of a POSTED or VOID daily close (Sprint 12a). Shows the frozen lines
 * + totals, the linked income transaction, and — when stock moved — the booked
 * consumed-ingredients readout. A posted close can be VOIDED (manager-only, soft-deletes
 * the income row + reverses stock); a void close shows its reversal count.
 */
export function SaleReadonly({
  sale,
  currency,
}: {
  sale: SaleDetail;
  currency: string;
}) {
  const t = useTranslations('sales');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();

  const [error, setError] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  const confirmVoid = () => {
    setError(null);
    startTransition(async () => {
      const result = await voidSaleAction(sale.id, { expectedUpdatedAt: sale.updatedAt });
      if (result.ok) router.refresh();
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
          href="/sales"
          className="inline-flex size-9 items-center justify-center rounded-full border border-border bg-surface text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
          aria-label={t('actions.back')}
        >
          <ArrowLeft className="size-4" />
        </Link>
        <h1 className="font-display text-xl font-semibold text-foreground">{sale.saleDate}</h1>
        <Badge variant={sale.status === 'posted' ? 'positive' : 'neutral'}>
          {t(`status.${sale.status}`)}
        </Badge>
        <div className="ml-auto">
          {sale.status === 'posted' && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmOpen(true)}
              disabled={pending}
            >
              <Ban className="size-4" />
              {t('actions.void')}
            </Button>
          )}
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

      {sale.status === 'void' && (
        <p className="rounded-lg border border-border bg-surface-2 px-4 py-2 text-sm text-muted-foreground">
          {t('voidedNote', { count: sale.consumptions.length })}
        </p>
      )}

      {sale.status === 'posted' && <DailyCloseSummaryCard saleId={sale.id} />}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t('lines.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    <th className="pb-2">{t('lines.item')}</th>
                    <th className="pb-2">{t('lines.units')}</th>
                    <th className="pb-2">{t('lines.unitNet')}</th>
                    <th className="pb-2">{t('lines.taxRate')}</th>
                    <th className="pb-2 text-right">{t('lines.gross')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sale.lines.map((line) => (
                    <tr key={line.id} className="border-b border-border last:border-0">
                      <td className="py-2 pr-2">
                        <span className="font-medium text-foreground">{line.itemName}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {t(`itemKind.${line.itemKind}`)}
                        </span>
                      </td>
                      <td className="py-2 pr-2 tabular-nums">{line.quantity}</td>
                      <td className="py-2 pr-2 tabular-nums">
                        {formatMoney(line.unitNetCents, currency)}
                      </td>
                      <td className="py-2 pr-2 tabular-nums">{bpsToPercent(line.taxRateBps)}%</td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(line.grossCents, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('totals.title')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-1.5 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('totals.net')}</span>
                <span className="tabular-nums">{formatMoney(sale.netCents ?? 0, currency)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('totals.tax')}</span>
                <span className="tabular-nums">{formatMoney(sale.taxCents ?? 0, currency)}</span>
              </div>
              <div className="flex items-center justify-between border-t border-border pt-1.5 font-medium">
                <span>{t('totals.gross')}</span>
                <span className="tabular-nums">{formatMoney(sale.grossCents ?? 0, currency)}</span>
              </div>
              {sale.transactionId && (
                <p className="pt-2 text-xs text-muted-foreground">{t('linkedTransaction')}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="inline-flex items-center gap-2">
                <PackageMinus className="size-4" />
                {t('consumption.title')}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              {sale.stockMoved ? (
                sale.consumptions.length === 0 ? (
                  <p className="text-muted-foreground">{t('consumption.none')}</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {sale.consumptions.map((c) => (
                      <li key={c.ingredientId} className="flex items-center justify-between">
                        <span className="text-foreground">{c.ingredientName}</span>
                        <span className="tabular-nums text-muted-foreground">{c.qtyCanonical}</span>
                      </li>
                    ))}
                  </ul>
                )
              ) : (
                <p className="text-muted-foreground">{t('consumption.financialOnly')}</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={t('voidConfirm.title')}
        description={t('voidConfirm.body', { date: sale.saleDate })}
        confirmLabel={t('actions.void')}
        cancelLabel={tCommon('cancel')}
        pending={pending}
        onConfirm={confirmVoid}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
