import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AlertTriangle, CalendarDays, Plus } from 'lucide-react';
import type { ProductionStatus } from '@/lib/db/schema';
import { formatMoney } from '@/lib/format/money';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

const STATUS_VARIANT: Record<ProductionStatus, 'neutral' | 'accent'> = {
  draft: 'neutral',
  planned: 'accent',
};

export type ListProduction = {
  id: string;
  reference: string | null;
  status: ProductionStatus;
  plannedFor: string | null;
  itemCount: number;
  complete: boolean;
  /** Manager only. Kitchen list items omit this key, so no money reaches the client. */
  costCents?: number | null;
};

/**
 * Production list (Sprint 11a), rendered for BOTH roles. Both see the reference (or a
 * fallback label), status, planned date, recipe count and an incomplete marker. A
 * manager additionally sees the current estimated cost (`canManage`). An incomplete
 * production shows `—` for money, never a partial total. The New control is visible
 * to both roles.
 */
export async function ProductionsList({
  productions,
  canManage,
  currency,
}: {
  productions: ListProduction[];
  canManage: boolean;
  currency: string;
}) {
  const t = await getTranslations('productions');

  const label = (p: ListProduction): string =>
    p.reference ?? p.plannedFor ?? `${t('fallbackLabel')} ${p.id.slice(0, 8)}`;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        <Button asChild>
          <Link href="/productions/new">
            <Plus className="size-4" />
            {t('actions.new')}
          </Link>
        </Button>
      </div>

      {productions.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-surface px-4 py-12 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {productions.map((production) => (
            <Card
              key={production.id}
              className="transition-colors hover:border-accent-300"
            >
              <CardContent className="flex flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <Link
                    href={`/productions/${production.id}`}
                    className="font-display text-base font-semibold text-foreground hover:text-accent-700"
                  >
                    {label(production)}
                  </Link>
                  <Badge variant={STATUS_VARIANT[production.status]}>
                    {t(`status.${production.status}`)}
                  </Badge>
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>{t('itemCount', { count: production.itemCount })}</span>
                  {production.plannedFor && (
                    <span className="inline-flex items-center gap-1">
                      <CalendarDays className="size-3.5" />
                      {production.plannedFor}
                    </span>
                  )}
                  {!production.complete && (
                    <Badge variant="warning">
                      <AlertTriangle className="size-3" />
                      {t('incomplete.badge')}
                    </Badge>
                  )}
                </div>

                {canManage && (
                  <div className="flex items-center gap-1.5 text-sm">
                    <span className="text-xs text-muted-foreground">
                      {t('cost.label')}
                    </span>
                    <span className="tabular-nums text-foreground">
                      {production.costCents != null
                        ? formatMoney(production.costCents, currency)
                        : t('cost.unavailable')}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
