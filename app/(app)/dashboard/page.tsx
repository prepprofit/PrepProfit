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
import { monthlyBuckets } from '@/lib/calculations/finance';
import { currentPeriodKey, resolvePeriod } from '@/lib/finance/period';
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

const shortMonth = (month: number) =>
  new Date(2000, month - 1, 1).toLocaleDateString('en', { month: 'short' });

/**
 * Dashboard — real figures from the org's recipes (active recipes, margin, food
 * cost, top recipes). The finance tiles (this-month revenue + income-vs-expense
 * chart) are shown to MANAGERS only; kitchen staff never see financial data,
 * even here (RULE: financials are manager-only).
 */
export default async function DashboardPage() {
  const t = await getTranslations('dashboard');
  const tFin = await getTranslations('finance.dashboard');
  const organizationId = await getOrgId();
  const canSeeFinance = canAccessFinancials(await getUserRole());
  const firstName = (await currentUser())?.firstName?.trim();

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

  // Finance tiles — managers only.
  const yearKey = currentPeriodKey('year');
  const year = resolvePeriod('year', yearKey);
  const finance = canSeeFinance
    ? await (async () => {
        const [yearTxns, settings] = await Promise.all([
          withOrg(organizationId, (tx) =>
            listTransactions(tx, organizationId, {
              from: year.from,
              to: year.to,
            }),
          ),
          getOrgSettings(),
        ]);
        const buckets = monthlyBuckets(yearTxns, year.year);
        const revenueCents = buckets[new Date().getMonth()]?.incomeCents ?? 0;
        return {
          currency: settings.currency,
          revenueCents,
          monthly: buckets.map((b) => ({
            label: shortMonth(b.month),
            incomeCents: b.incomeCents,
            expenseCents: b.expenseCents,
            profitCents: b.profitCents,
          })),
        };
      })()
    : null;

  const pricedCaption = t('kpi.pricedRecipes', { count: summary.pricedRecipes });
  const pct = (value: number | null) => (value == null ? '—' : `${value}%`);
  const marginCaption =
    summary.avgMarginPercent == null ? t('kpi.noPricedRecipes') : pricedCaption;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {firstName ? t('welcome', { name: firstName }) : t('welcomeGeneric')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {/* KPI row — recipe metrics for everyone; revenue for managers only. The
          primary KPI is featured (solid accent): revenue for managers, else the
          active-recipe count for kitchen staff. */}
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
            caption={t('kpi.thisMonth')}
            icon={DollarSign}
            featured
          />
        )}
      </div>

      {/* Bento grid — chart + margin gauge on top (managers), top recipes full
          width below; for kitchen staff the gauge and list sit side by side. */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {finance && (
          <Card className="flex flex-col md:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">{tFin('monthlyTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              <MonthlyChart data={finance.monthly} currency={finance.currency} />
            </CardContent>
          </Card>
        )}
        <MarginGauge value={summary.avgMarginPercent} />
        <TopRecipes
          title={t('topRecipes')}
          recipes={summary.topByMargin}
          emptyLabel={t('noRecipes')}
          className={finance ? 'md:col-span-2 xl:col-span-3' : undefined}
        />
      </div>
    </div>
  );
}
