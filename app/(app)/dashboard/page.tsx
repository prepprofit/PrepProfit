import { getTranslations } from 'next-intl/server';
import { currentUser } from '@clerk/nextjs/server';
import {
  DollarSign,
  FileText,
  Percent,
  TrendingUp,
  Utensils,
  Wallet,
} from 'lucide-react';
import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listRecipesWithLines } from '@/lib/data/recipes';
import { listIngredients } from '@/lib/data/ingredients';
import { listTransactions } from '@/lib/data/transactions';
import { listInvoices } from '@/lib/data/invoices';
import { getOrgSettings } from '@/lib/data/org-settings';
import {
  dashboardSummary,
  type DashboardRecipeInput,
} from '@/lib/calculations/dashboard';
import {
  comparePeriods,
  financeSummary,
  monthlyBuckets,
  type PeriodComparison,
} from '@/lib/calculations/finance';
import { invoiceSummary } from '@/lib/calculations/invoice';
import { selectLowStock } from '@/lib/calculations/inventory';
import { categoryLabel } from '@/lib/finance/categories';
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
import { StatCard, type StatCardProps } from '@/components/ui/stat-card';
import { TopRecipes } from '@/components/app/dashboard/top-recipes';
import { MarginGauge } from '@/components/app/dashboard/margin-gauge';
import { MonthlyChart } from '@/components/app/finance/monthly-chart';
import { CategoryBreakdown } from '@/components/app/finance/category-breakdown';
import { TopProducts } from '@/components/app/finance/top-products';
import { DashboardPeriodSelect } from '@/components/app/dashboard/dashboard-period-select';
import { RecentTransactions } from '@/components/app/dashboard/recent-transactions';
import { InvoiceSummaryCard } from '@/components/app/dashboard/invoice-summary-card';
import {
  LowStockCard,
  type LowStockItem,
} from '@/components/app/dashboard/low-stock-card';

const shortMonth = (month: number) =>
  new Date(2000, month - 1, 1).toLocaleDateString('en', { month: 'short' });

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Local 'YYYY-MM-DD' for today (matches the tz-free bare-date convention). */
function todayKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

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

/**
 * A StatCard delta for a money figure vs the prior period. `goodWhen` decouples
 * tone from direction: revenue/profit are good when UP, expenses good when DOWN —
 * so a rise in expenses shows an up arrow with a "negative" (bad) tone.
 */
function moneyDelta(
  comparison: PeriodComparison,
  goodWhen: 'up' | 'down',
  vsLabel: string,
  noBaselineLabel: string,
): { delta: StatCardProps['delta']; caption: string } {
  if (comparison.changePercent == null) {
    return { delta: undefined, caption: noBaselineLabel };
  }
  const rose = comparison.deltaCents >= 0;
  const isGood = goodWhen === 'up' ? rose : !rose;
  return {
    delta: {
      label: `${Math.abs(comparison.changePercent)}%`,
      tone: isGood ? 'positive' : 'negative',
      direction: rose ? 'up' : 'down',
    },
    caption: vsLabel,
  };
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations('dashboard');
  const tFin = await getTranslations('finance.dashboard');
  const tCat = await getTranslations('finance.categories');
  const organizationId = await getOrgId();
  const canSeeFinance = canAccessFinancials(await getUserRole());
  const firstName = (await currentUser())?.firstName?.trim();
  const settings = await getOrgSettings();
  const sp = await searchParams;

  // Period for the financial widgets — defaults to current month.
  const currentKey = currentPeriodKey('month');
  const periodKey =
    typeof sp.period === 'string' && isValidPeriodKey('month', sp.period)
      ? sp.period
      : currentKey;
  const resolved = resolvePeriod('month', periodKey);
  const periodOptions = buildPeriodOptions(currentKey);

  // Recipes + ingredients are operational (no financial figures) — both roles.
  const { recipes, ingredients } = await withOrg(organizationId, async (tx) => ({
    recipes: await listRecipesWithLines(tx, organizationId),
    ingredients: await listIngredients(tx, organizationId),
  }));

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

  // Low-stock "to reorder" list — operational, shown to both roles.
  const lowStock: LowStockItem[] = selectLowStock(
    ingredients.map((i) => ({
      id: i.id,
      name: i.name,
      dimension: i.dimension,
      stockCanonical: Number(i.stockQuantity),
      thresholdCanonical:
        i.lowStockThreshold == null ? null : Number(i.lowStockThreshold),
    })),
  ).map((i) => ({
    id: i.id,
    name: i.name,
    dimension: i.dimension,
    stockCanonical: i.stockCanonical,
    thresholdCanonical: i.thresholdCanonical as number,
  }));

  // Finance data — managers only.
  const finance = canSeeFinance
    ? await (async () => {
        const yearKey = String(resolved.year);
        const year = resolvePeriod('year', yearKey);

        const txns = await withOrg(organizationId, async (tx) => ({
          year: await listTransactions(tx, organizationId, {
            from: year.from,
            to: year.to,
          }),
          period: await listTransactions(tx, organizationId, {
            from: resolved.from,
            to: resolved.to,
          }),
          prior: await listTransactions(tx, organizationId, {
            from: resolved.priorFrom,
            to: resolved.priorTo,
          }),
          recent: await listTransactions(tx, organizationId, { limit: 8 }),
        }));
        const invoices = await withOrg(organizationId, (tx) =>
          listInvoices(tx, organizationId),
        );

        const periodSummary = financeSummary(txns.period);
        const priorSummary = financeSummary(txns.prior);

        return {
          currency: settings.currency,
          periodSummary,
          revenueComparison: comparePeriods(
            periodSummary.incomeCents,
            priorSummary.incomeCents,
          ),
          profitComparison: comparePeriods(
            periodSummary.profitCents,
            priorSummary.profitCents,
          ),
          expenseComparison: comparePeriods(
            periodSummary.expenseCents,
            priorSummary.expenseCents,
          ),
          invoices: invoiceSummary(invoices, todayKey()),
          categoryItems: periodSummary.byCategory
            .filter((c) => c.kind === 'expense')
            .map((c) => ({
              id: c.categoryId,
              name: categoryLabel(c, (slug) => tCat(slug)),
              kind: c.kind,
              totalCents: c.totalCents,
            })),
          monthly: monthlyBuckets(txns.year, resolved.year).map((b) => ({
            label: shortMonth(b.month),
            incomeCents: b.incomeCents,
            expenseCents: b.expenseCents,
            profitCents: b.profitCents,
          })),
          recentTxns: txns.recent,
        };
      })()
    : null;

  const pricedCaption = t('kpi.pricedRecipes', { count: summary.pricedRecipes });
  const pct = (value: number | null) => (value == null ? '—' : `${value}%`);
  const marginCaption =
    summary.avgMarginPercent == null ? t('kpi.noPricedRecipes') : pricedCaption;

  const periodLabel =
    periodKey === currentKey
      ? t('kpi.thisMonth')
      : new Date(resolved.year, Number(periodKey.slice(5, 7)) - 1, 1).toLocaleDateString(
          'en',
          { month: 'short', year: 'numeric' },
        );

  const revenue = finance
    ? moneyDelta(finance.revenueComparison, 'up', periodLabel, periodLabel)
    : null;
  const profit = finance
    ? moneyDelta(finance.profitComparison, 'up', tFin('vsPrevious'), tFin('noBaseline'))
    : null;
  const expenses = finance
    ? moneyDelta(finance.expenseComparison, 'down', tFin('vsPrevious'), tFin('noBaseline'))
    : null;

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

      {/* Money KPI row — managers only */}
      {finance && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label={t('kpi.revenue')}
            value={formatMoney(finance.periodSummary.incomeCents, finance.currency)}
            delta={revenue?.delta}
            caption={revenue?.caption}
            icon={DollarSign}
            featured
          />
          <StatCard
            label={t('kpi.profit')}
            value={formatMoney(finance.periodSummary.profitCents, finance.currency)}
            delta={profit?.delta}
            caption={profit?.caption}
            icon={TrendingUp}
          />
          <StatCard
            label={t('kpi.expenses')}
            value={formatMoney(finance.periodSummary.expenseCents, finance.currency)}
            delta={expenses?.delta}
            caption={expenses?.caption}
            icon={Wallet}
          />
          <StatCard
            label={t('kpi.accountsReceivable')}
            value={formatMoney(finance.invoices.outstandingCents, finance.currency)}
            caption={t('invoices.outstandingCaption', {
              count: finance.invoices.issuedCount,
            })}
            icon={FileText}
          />
        </div>
      )}

      {/* Operational KPI row — both roles */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
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
          caption={summary.avgMarginPercent == null ? undefined : pricedCaption}
        />

        {finance && (
          <>
            <Card className="flex flex-col">
              <CardHeader>
                <CardTitle>{tFin('byCategory')}</CardTitle>
              </CardHeader>
              <CardContent>
                <CategoryBreakdown
                  items={finance.categoryItems}
                  currency={finance.currency}
                  emptyLabel={tFin('byCategoryEmpty')}
                />
              </CardContent>
            </Card>
            <Card className="flex flex-col">
              <CardHeader>
                <CardTitle>{tFin('topProducts')}</CardTitle>
              </CardHeader>
              <CardContent>
                <TopProducts
                  products={finance.periodSummary.topProducts}
                  currency={finance.currency}
                  emptyLabel={tFin('topProductsEmpty')}
                />
              </CardContent>
            </Card>
            <InvoiceSummaryCard
              summary={finance.invoices}
              currency={finance.currency}
              labels={{
                title: t('invoices.title'),
                outstanding: t('invoices.outstanding'),
                overdue: t('invoices.overdue'),
                drafts: t('invoices.drafts'),
                issued: t('invoices.issued'),
                paid: t('invoices.paid'),
                viewAll: t('viewAll'),
              }}
            />
          </>
        )}

        <LowStockCard
          items={lowStock}
          measurementSystem={settings.measurementSystem}
          title={t('lowStock.title')}
          emptyLabel={t('lowStock.empty')}
          viewAllLabel={t('viewAll')}
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
        />
      </div>
    </div>
  );
}
