import { getTranslations } from 'next-intl/server';
import { DollarSign, Percent, TrendingUp, Utensils } from 'lucide-react';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listRecipesWithLines } from '@/lib/data/recipes';
import {
  dashboardSummary,
  type DashboardRecipeInput,
} from '@/lib/calculations/dashboard';
import { StatCard } from '@/components/ui/stat-card';
import { ChartPlaceholder } from '@/components/app/dashboard/chart-placeholder';
import { TopRecipes } from '@/components/app/dashboard/top-recipes';

/**
 * Dashboard — real figures derived live from the org's recipes (active recipes,
 * average margin, average food cost, top recipes by margin). Revenue and the
 * chart tiles depend on the `transactions` table and arrive in Sprint 2; until
 * then they show an honest empty state rather than sample numbers.
 */
export default async function DashboardPage() {
  const t = await getTranslations('dashboard');
  const organizationId = await getOrgId();

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

  const pricedCaption = t('kpi.pricedRecipes', { count: summary.pricedRecipes });
  const pct = (value: number | null) => (value == null ? '—' : `${value}%`);
  const marginCaption =
    summary.avgMarginPercent == null ? t('kpi.noPricedRecipes') : pricedCaption;
  const sprint2 = t('sprint2');

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>

      {/* KPI row — real metrics first, finance (Sprint 2) last */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t('kpi.recipes')}
          value={String(summary.activeRecipes)}
          caption={pricedCaption}
          icon={Utensils}
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
        <StatCard
          label={t('kpi.revenue')}
          value="—"
          caption={t('kpi.availableSprint2')}
          icon={DollarSign}
        />
      </div>

      {/* Bento grid */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <ChartPlaceholder
          className="md:col-span-2"
          title={t('charts.sales.title')}
          description={t('charts.sales.subtitle')}
          note={sprint2}
          emptyLabel={t('chartEmpty')}
        />
        <TopRecipes
          title={t('topRecipes')}
          recipes={summary.topByMargin}
          emptyLabel={t('noRecipes')}
        />
        <ChartPlaceholder
          title={t('charts.margin.title')}
          description={t('charts.margin.subtitle')}
          note={sprint2}
          emptyLabel={t('chartEmpty')}
        />
        <ChartPlaceholder
          title={t('charts.costs.title')}
          description={t('charts.costs.subtitle')}
          note={sprint2}
          emptyLabel={t('chartEmpty')}
        />
        <ChartPlaceholder
          title={t('charts.cashflow.title')}
          description={t('charts.cashflow.subtitle')}
          note={sprint2}
          emptyLabel={t('chartEmpty')}
        />
      </div>
    </div>
  );
}
