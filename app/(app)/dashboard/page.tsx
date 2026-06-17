import { getTranslations } from 'next-intl/server';
import { currentUser } from '@clerk/nextjs/server';
import { DollarSign, Percent, TrendingUp, Utensils } from 'lucide-react';
import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listRecipesWithLines } from '@/lib/data/recipes';
import { listTransactions } from '@/lib/data/transactions';
import { getOrgSettings } from '@/lib/data/org-settings';
import {
  dashboardSummary,
  type DashboardRecipeInput,
} from '@/lib/calculations/dashboard';
import { financeSummary, monthlyBuckets } from '@/lib/calculations/finance';
import {
  currentPeriodKey,
  isValidPeriodKey,
  resolvePeriod,
} from '@/lib/finance/period';
import { formatMoney } from '@/lib/format/money';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { TopRecipes } from '@/components/app/dashboard/top-recipes';
import { MarginGauge } from '@/components/app/dashboard/margin-gauge';
import { MonthlyChart } from '@/components/app/finance/monthly-chart';
import { DashboardPeriodSelect } from '@/components/app/dashboard/dashboard-period-select';
import { RecentTransactions } from '@/components/app/dashboard/recent-transactions';

const shortMonth = (month: number) =>
  new Date(2000, month - 1, 1).toLocaleDateString('en', { month: 'short' });

/** Last 12 month keys descending from the given month key, for the period select. */
function buildPeriodOptions(currentKey: string): { key: string; label: string }[] {
  const year = Number(currentKey.slice(0, 4));
  const month = Number(currentKey.slice(5, 7));
  const options: { key: string; label: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(year, month - 1 - i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const key = `${y}-${m}`;
    const label = d.toLocaleDateString('en', { month: 'long', year: 'numeric' });
    options.push({ key, label });
  }
  return options;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations('dashboard');
  const tFin = await getTranslations('finance.dashboard');
  const organizationId = await getOrgId();
  const canSeeFinance = canAccessFinancials(await getUserRole());
  const firstName = (await currentUser())?.firstName?.trim();
  const sp = await searchParams;

  // Period for the revenue KPI — defaults to current month.
  const todayKey = currentPeriodKey('month');
  const periodKey =
    typeof sp.period === 'string' && isValidPeriodKey('month', sp.period)
      ? sp.period
      : todayKey;
  const resolved = resolvePeriod('month', periodKey);
  const periodOptions = buildPeriodOptions(todayKey);

  const recipes = await withOrg(organizationId, (tx) =>
    listRecipesWithLines(tx, organizationId),
  );

  const input: DashboardRecipeInput[] = recipes.map(({ recipe, lines }) => ({
    id: recipe.id,
    name: recipe.name,
    sellingPriceCents: recipe.sellingPriceCents,
    cost: {
      yieldPortions: recipe.yieldPortions,
      yieldPercentage: recipe.yieldPercentage,
      laborCostCents: recipe.laborCostCents,
      energyCostCents: recipe.energyCostCents,
      packagingCostCents: recipe.packagingCostCents,
      lines: lines.map((l) => ({
        dimension: l.ingredient.dimension,
        priceCents: l.ingredient.priceCents,
        quantity: l.quantity,
      })),
    },
  }));

  const summary = dashboardSummary(input);

  // Finance data — managers only.
  const finance = canSeeFinance
    ? await (async () => {
        const yearKey = String(resolved.year);
        const year = resolvePeriod('year', yearKey);

        const [yearTxns, periodTxns, recentTxns, settings] = await Promise.all([
          withOrg(organizationId, (tx) =>
            listTransactions(tx, organizationId, {
              from: year.from,
              to: year.to,
            }),
          ),
          withOrg(organizationId, (tx) =>
            listTransactions(tx, organizationId, {
              from: resolved.from,
              to: resolved.to,
            }),
          ),
          withOrg(organizationId, (tx) =>
            listTransactions(tx, organizationId, { limit: 8 }),
          ),
          getOrgSettings(),
        ]);

        const buckets = monthlyBuckets(yearTxns, resolved.year);
        const periodSummary = financeSummary(periodTxns);

        return {
          currency: settings.currency,
          revenueCents: periodSummary.incomeCents,
          monthly: buckets.map((b) => ({
            label: shortMonth(b.month),
            incomeCents: b.incomeCents,
            expenseCents: b.expenseCents,
            profitCents: b.profitCents,
          })),
          recentTxns,
        };
      })()
    : null;

  const pricedCaption = t('kpi.pricedRecipes', { count: summary.pricedRecipes });
  const pct = (value: number | null) => (value == null ? '—' : `${value}%`);
  const marginCaption =
    summary.avgMarginPercent == null ? t('kpi.noPricedRecipes') : pricedCaption;

  const periodLabel =
    periodKey === todayKey
      ? t('kpi.thisMonth')
      : new Date(resolved.year, Number(periodKey.slice(5, 7)) - 1, 1).toLocaleDateString(
          'en',
          { month: 'short', year: 'numeric' },
        );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            {firstName ? t('welcome', { name: firstName }) : t('welcomeGeneric')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {canSeeFinance && (
          <DashboardPeriodSelect value={periodKey} options={periodOptions} />
        )}
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t('kpi.recipes')}
          value={String(summary.activeRecipes)}
          caption={pricedCaption}
          icon={Utensils}
          featured={!finance}
        />
        <StatCard
          label={t('kpi.margin')}
          value={pct(summary.avgMarginPercent)}
          caption={marginCaption}
          icon={TrendingUp}
        />
        <StatCard
          label={t('kpi.foodCost')}
          value={pct(summary.avgFoodCostPercent)}
          caption={marginCaption}
          icon={Percent}
        />
        {finance && (
          <StatCard
            label={t('kpi.revenue')}
            value={formatMoney(finance.revenueCents, finance.currency)}
            caption={periodLabel}
            icon={DollarSign}
            featured
          />
        )}
      </div>

      {/* Bento grid */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {finance && (
          <Card className="flex flex-col md:col-span-2">
            <CardHeader>
              <CardTitle>{tFin('monthlyTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              <MonthlyChart data={finance.monthly} currency={finance.currency} />
            </CardContent>
          </Card>
        )}
        <MarginGauge
          value={summary.avgMarginPercent}
          caption={
            summary.avgMarginPercent == null ? undefined : pricedCaption
          }
        />
        {finance && (
          <RecentTransactions
            rows={finance.recentTxns}
            currency={finance.currency}
            title={t('recentTransactions')}
            emptyLabel={t('noRecentTransactions')}
            viewAllLabel={t('viewAll')}
            className="md:col-span-2"
          />
        )}
        <TopRecipes
          title={t('topRecipes')}
          recipes={summary.topByMargin}
          emptyLabel={t('noRecipes')}
          className={finance ? 'xl:col-span-3' : undefined}
        />
      </div>
    </div>
  );
}
