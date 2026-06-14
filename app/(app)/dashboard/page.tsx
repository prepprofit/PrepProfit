import { getTranslations } from 'next-intl/server';
import { DollarSign, Percent, TrendingUp, Utensils } from 'lucide-react';
import { StatCard } from '@/components/ui/stat-card';
import { ChartPlaceholder } from '@/components/app/dashboard/chart-placeholder';
import { TopRecipes } from '@/components/app/dashboard/top-recipes';

/**
 * Mocked dashboard — bento grid showcasing the design system. KPI stat cards use
 * sample figures; the chart tiles are placeholders until Sprint 2 wires real
 * data + a chart library (DESIGN.md §9).
 */
export default async function DashboardPage() {
  const t = await getTranslations('dashboard');
  const sprint2 = t('sprint2');

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t('kpi.revenue')}
          value="€18,240"
          delta={{ label: '12%', tone: 'positive', direction: 'up' }}
          caption={t('kpi.vsLastMonth')}
          icon={DollarSign}
        />
        <StatCard
          label={t('kpi.foodCost')}
          value="29.4%"
          delta={{ label: '1.8%', tone: 'positive', direction: 'down' }}
          caption={t('kpi.vsLastMonth')}
          icon={Percent}
        />
        <StatCard
          label={t('kpi.margin')}
          value="64.2%"
          delta={{ label: '3.1%', tone: 'positive', direction: 'up' }}
          caption={t('kpi.vsLastMonth')}
          icon={TrendingUp}
        />
        <StatCard
          label={t('kpi.recipes')}
          value="42"
          delta={{ label: '4', tone: 'neutral', direction: 'up' }}
          caption={t('kpi.thisMonth')}
          icon={Utensils}
        />
      </div>

      {/* Bento grid */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <ChartPlaceholder
          className="md:col-span-2"
          title={t('charts.sales.title')}
          description={t('charts.sales.subtitle')}
          note={sprint2}
        />
        <TopRecipes title={t('topRecipes')} />
        <ChartPlaceholder
          title={t('charts.margin.title')}
          description={t('charts.margin.subtitle')}
          note={sprint2}
        />
        <ChartPlaceholder
          title={t('charts.costs.title')}
          description={t('charts.costs.subtitle')}
          note={sprint2}
        />
        <ChartPlaceholder
          title={t('charts.cashflow.title')}
          description={t('charts.cashflow.subtitle')}
          note={sprint2}
        />
      </div>
    </div>
  );
}
