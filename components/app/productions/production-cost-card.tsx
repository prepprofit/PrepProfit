import { getTranslations } from 'next-intl/server';
import type { ProductionCost } from '@/lib/data/productions';
import { formatMoney } from '@/lib/format/money';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Manager-only estimated production cost (Sprint 11a). Rendered ONLY from the manager
 * loader's `cost`; the kitchen server payload never carries this key (F4). An
 * incomplete production (any unavailable recipe) shows `—`, never a partial total.
 */
export async function ProductionCostCard({
  cost,
  currency,
}: {
  cost: ProductionCost;
  currency: string;
}) {
  const t = await getTranslations('productions');

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('cost.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm text-muted-foreground">{t('cost.label')}</span>
          <span className="font-display text-xl font-semibold tabular-nums text-foreground">
            {cost.costCents != null
              ? formatMoney(cost.costCents, currency)
              : t('cost.unavailable')}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
