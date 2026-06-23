import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Info, Plus } from 'lucide-react';
import type { SaleStatus } from '@/lib/db/schema';
import type { SaleListItem } from '@/lib/data/sales';
import { formatMoney } from '@/lib/format/money';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

const STATUS_VARIANT: Record<SaleStatus, 'neutral' | 'positive'> = {
  draft: 'neutral',
  posted: 'positive',
  void: 'neutral',
};

/**
 * Daily-close sales list (Sprint 12a), manager-only. Shows each close's date, status,
 * line count and FROZEN gross (drafts show `—` — money is frozen only on post). The
 * banner states the accepted-v1 double-count limitation (don't also import revenue
 * from the bank).
 */
export async function SalesList({
  sales,
  currency,
}: {
  sales: SaleListItem[];
  currency: string;
}) {
  const t = await getTranslations('sales');

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        <Button asChild>
          <Link href="/sales/new">
            <Plus className="size-4" />
            {t('actions.new')}
          </Link>
        </Button>
      </div>

      <p
        role="note"
        className="inline-flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
      >
        <Info className="mt-0.5 size-4 shrink-0" />
        {t('doubleCountWarning')}
      </p>

      {sales.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-surface px-4 py-12 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {sales.map((sale) => (
            <Card key={sale.id} className="transition-colors hover:border-accent-300">
              <CardContent className="flex flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <Link
                    href={`/sales/${sale.id}`}
                    className="font-display text-base font-semibold text-foreground hover:text-accent-700"
                  >
                    {sale.saleDate}
                  </Link>
                  <Badge variant={STATUS_VARIANT[sale.status]}>
                    {t(`status.${sale.status}`)}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>{t('lineCount', { count: sale.lineCount })}</span>
                  <span className="tabular-nums text-sm text-foreground">
                    {sale.grossCents != null
                      ? formatMoney(sale.grossCents, currency)
                      : '—'}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
