import { getTranslations } from 'next-intl/server';
import { DollarSign, TrendingUp, Wallet } from 'lucide-react';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getOrgSettings } from '@/lib/data/org-settings';
import { listTransactions } from '@/lib/data/transactions';
import {
  comparePeriods,
  financeSummary,
  monthlyBuckets,
} from '@/lib/calculations/finance';
import { categoryLabel } from '@/lib/finance/categories';
import { resolvePeriod, type PeriodView } from '@/lib/finance/period';
import { formatMoney } from '@/lib/format/money';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { StatCard, type StatCardProps } from '@/components/ui/stat-card';
import { MonthlyChart } from '@/components/app/finance/monthly-chart';
import { CategoryBreakdown } from '@/components/app/finance/category-breakdown';
import { TopProducts } from '@/components/app/finance/top-products';

const shortMonth = (month: number) =>
  new Date(2000, month - 1, 1).toLocaleDateString('en', { month: 'short' });

/**
 * Async data section for the financials dashboards. Fetches the selected period
 * (and the prior period, for comparison), aggregates with the pure finance
 * functions, and renders KPIs, the by-category breakdown, top products, and — in
 * the year view — the month-over-month chart. Suspends behind the page skeleton.
 */
export async function FinancialsContent({
  view,
  periodKey,
}: {
  view: PeriodView;
  periodKey: string;
}) {
  const t = await getTranslations('finance.dashboard');
  const tCat = await getTranslations('finance.categories');
  const organizationId = await getOrgId();
  const resolved = resolvePeriod(view, periodKey);

  const [data, settings] = await Promise.all([
    withOrg(organizationId, async (tx) => {
      const current = await listTransactions(tx, organizationId, {
        from: resolved.from,
        to: resolved.to,
      });
      const prior = await listTransactions(tx, organizationId, {
        from: resolved.priorFrom,
        to: resolved.priorTo,
      });
      return { current, prior };
    }),
    getOrgSettings(),
  ]);

  const currency = settings.currency;
  const summary = financeSummary(data.current);
  const priorSummary = financeSummary(data.prior);
  const comparison = comparePeriods(summary.profitCents, priorSummary.profitCents);

  const profitDelta: StatCardProps['delta'] =
    comparison.changePercent == null
      ? undefined
      : {
          label: `${Math.abs(comparison.changePercent)}%`,
          tone: comparison.deltaCents >= 0 ? 'positive' : 'negative',
          direction: comparison.deltaCents >= 0 ? 'up' : 'down',
        };
  const profitCaption =
    comparison.changePercent == null ? t('noBaseline') : t('vsPrevious');

  const categoryItems = summary.byCategory.map((c) => ({
    id: c.categoryId,
    name: categoryLabel(c, (slug) => tCat(slug)),
    kind: c.kind,
    totalCents: c.totalCents,
  }));

  const monthlyData =
    view === 'year'
      ? monthlyBuckets(data.current, resolved.year).map((b) => ({
          label: shortMonth(b.month),
          incomeCents: b.incomeCents,
          expenseCents: b.expenseCents,
          profitCents: b.profitCents,
        }))
      : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label={t('income')}
          value={formatMoney(summary.incomeCents, currency)}
          icon={DollarSign}
        />
        <StatCard
          label={t('expenses')}
          value={formatMoney(summary.expenseCents, currency)}
          icon={Wallet}
        />
        <StatCard
          label={t('profit')}
          value={formatMoney(summary.profitCents, currency)}
          delta={profitDelta}
          caption={profitCaption}
          icon={TrendingUp}
        />
      </div>

      {monthlyData && (
        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle>{t('monthlyTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <MonthlyChart data={monthlyData} currency={currency} />
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle>{t('byCategory')}</CardTitle>
          </CardHeader>
          <CardContent>
            <CategoryBreakdown
              items={categoryItems}
              currency={currency}
              emptyLabel={t('byCategoryEmpty')}
            />
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle>{t('topProducts')}</CardTitle>
          </CardHeader>
          <CardContent>
            <TopProducts
              products={summary.topProducts}
              currency={currency}
              emptyLabel={t('topProductsEmpty')}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
