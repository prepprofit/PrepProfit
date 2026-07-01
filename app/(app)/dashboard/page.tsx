import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  DollarSign,
  FileText,
  Percent,
  TrendingUp,
  Utensils,
  Wallet,
} from 'lucide-react';
import { canAccessFinancials, getFirstName, getOrgId, getUserRole } from '@/lib/auth';
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
import { DashboardChartCard } from '@/components/app/dashboard/dashboard-chart-card';
import { CategoryBreakdown } from '@/components/app/finance/category-breakdown';
import { TopProducts } from '@/components/app/finance/top-products';
import { DashboardPeriodSelect } from '@/components/app/dashboard/dashboard-period-select';
import { RecentTransactions } from '@/components/app/dashboard/recent-transactions';
import { InvoiceSummaryCard } from '@/components/app/dashboard/invoice-summary-card';
import {
  LowStockCard,
  type LowStockItem,
} from '@/components/app/dashboard/low-stock-card';
import {
  ProfitLeaksCard,
  type ProfitLeakRow,
  type ProfitLeakStat,
} from '@/components/app/dashboard/profit-leaks-card';
import { loadProfitLeaks } from '@/lib/data/profit-leaks';
import { MARGIN_THRESHOLDS } from '@/lib/calculations/margin';
import { leakHref, leakLabel } from '@/lib/profit-leaks/labels';

const shortMonth = (month: number, locale: string) =>
  new Date(2000, month - 1, 1).toLocaleDateString(locale, { month: 'short' });

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Local 'YYYY-MM-DD' for today (matches the tz-free bare-date convention). */
function todayKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** Last 12 month keys descending from the given month key, for the period select. */
function buildPeriodOptions(
  currentKey: string,
  locale: string,
): { key: string; label: string }[] {
  const year = Number(currentKey.slice(0, 4));
  const month = Number(currentKey.slice(5, 7));
  const options: { key: string; label: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(year, month - 1 - i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const key = `${y}-${m}`;
    const label = d.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
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
  const tLeaks = await getTranslations('dashboard.profitLeaks');
  const organizationId = await getOrgId();
  // The dashboard is a manager cockpit — financial figures throughout (and the
  // operational KPIs are derived from recipe cost/price). Kitchen staff don't see
  // it at all; they're sent to their workspace. The nav hides the link and this
  // guard enforces it server-side (defense-in-depth, mirrors /settings).
  if (!canAccessFinancials(await getUserRole())) {
    redirect('/recipes');
  }
  const settings = await getOrgSettings();
  // Post-signup onboarding gate (Sprint 4d). A manager whose org hasn't finished
  // onboarding lands here (the sign-up fallback redirect → /dashboard) and is sent
  // through the guided setup once. Set-once, so this never loops. Kitchen staff are
  // already redirected to /recipes above and never see this.
  if (settings.onboardedAt == null) {
    redirect('/onboarding');
  }
  const firstName = await getFirstName();
  const locale = await getLocale();
  const sp = await searchParams;

  // Period for the financial widgets — defaults to current month.
  const currentKey = currentPeriodKey('month');
  const periodKey =
    typeof sp.period === 'string' && isValidPeriodKey('month', sp.period)
      ? sp.period
      : currentKey;
  const resolved = resolvePeriod('month', periodKey);
  const periodOptions = buildPeriodOptions(currentKey, locale);

  // Recipes + ingredients are operational (no financial figures) — both roles.
  const { recipes, ingredients, profitLeaks } = await withOrg(
    organizationId,
    async (tx) => ({
      recipes: await listRecipesWithLines(tx, organizationId),
      ingredients: await listIngredients(tx, organizationId),
      profitLeaks: await loadProfitLeaks(tx, organizationId),
    }),
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

  // Finance data — the page is manager-only (kitchen is redirected above).
  const finance = await (async () => {
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
            label: shortMonth(b.month, locale),
            incomeCents: b.incomeCents,
            expenseCents: b.expenseCents,
            profitCents: b.profitCents,
          })),
          recentTxns: txns.recent,
        };
      })();

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

  // Profit leaks — deterministic margin-risk findings (Sprint 1). The page is
  // manager-only (kitchen is redirected above), so these financial findings and
  // their card are never exposed to kitchen.
  const target = MARGIN_THRESHOLDS.green;
  const leakStats: ProfitLeakStat[] = [
    {
      label: tLeaks('summary.critical', {
        count: profitLeaks.filter((f) => f.severity === 'critical').length,
      }),
      tone: 'critical',
    },
    {
      label: tLeaks('summary.belowTarget', {
        count: profitLeaks.filter(
          (f) =>
            f.type === 'RECIPE_BELOW_TARGET_MARGIN' ||
            f.type === 'MENU_BELOW_TARGET_MARGIN',
        ).length,
        target,
      }),
      tone: 'warning',
    },
    {
      label: tLeaks('summary.unpriced', {
        count: new Set(
          profitLeaks
            .filter((f) => f.type.startsWith('UNPRICED_'))
            .map((f) => f.entityId),
        ).size,
      }),
      tone: 'muted',
    },
  ];
  const leakRows: ProfitLeakRow[] = profitLeaks.slice(0, 5).map((f) => ({
    id: f.fingerprint,
    severity: f.severity,
    href: leakHref(f),
    label: leakLabel(f, target, (key, values) => tLeaks(key, values)),
  }));

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
        <DashboardPeriodSelect value={periodKey} options={periodOptions} />
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
          <ProfitLeaksCard
            title={tLeaks('title')}
            emptyLabel={tLeaks('empty', { target })}
            stats={leakStats}
            rows={leakRows}
            viewAllHref="/insights"
            viewAllLabel={tLeaks('viewInbox')}
          />
        )}
        {finance && (
          <DashboardChartCard
            data={finance.monthly}
            currency={finance.currency}
            className="md:col-span-2"
            labels={{
              title: t('analytics.title'),
              incomeVsExpenses: t('analytics.incomeVsExpenses'),
              profit: t('analytics.profit'),
              income: t('analytics.income'),
              expenses: t('analytics.expenses'),
              cashflow: t('analytics.cashflow'),
            }}
          />
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
