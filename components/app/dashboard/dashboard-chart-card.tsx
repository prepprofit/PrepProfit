'use client';

import { useMemo, useState } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { FINANCE_COLORS } from '@/components/ui/chart';
import { cn } from '@/lib/utils';
import { cumulativeProfit, type MonthlyBucket } from '@/lib/calculations/finance';
import {
  MonthlyChart,
  type MonthlyDatum,
} from '@/components/app/finance/monthly-chart';
import {
  MetricAreaChart,
  type MetricDatum,
} from '@/components/app/dashboard/metric-area-chart';

const CHART_KEYS = [
  'incomeVsExpenses',
  'profit',
  'income',
  'expenses',
  'cashflow',
] as const;
type ChartKey = (typeof CHART_KEYS)[number];

export type ChartCardLabels = Record<'title' | ChartKey, string>;

/**
 * The dashboard's main analytics card: one chart with a top-right dropdown to
 * switch metric (income vs expenses, profit, revenue, expenses, cash flow). All
 * series derive from the monthly buckets already fetched, so switching is a pure
 * client re-render — no refetch. Manager-only (rendered behind the finance gate).
 */
export function DashboardChartCard({
  data,
  currency,
  labels,
  className,
}: {
  data: MonthlyDatum[];
  currency: string;
  labels: ChartCardLabels;
  className?: string;
}) {
  const [selected, setSelected] = useState<ChartKey>('incomeVsExpenses');

  // Last month with any activity — series are nulled after it so a line stops
  // cleanly instead of flat-lining across the rest of the year.
  const lastActive = useMemo(() => {
    let idx = -1;
    data.forEach((d, i) => {
      if (d.incomeCents !== 0 || d.expenseCents !== 0) idx = i;
    });
    return idx;
  }, [data]);

  const singleSeries = (pick: (d: MonthlyDatum) => number): MetricDatum[] =>
    data.map((d, i) => ({
      label: d.label,
      valueCents: i <= lastActive ? pick(d) : null,
    }));

  const cashflowSeries = useMemo<MetricDatum[]>(() => {
    const buckets: MonthlyBucket[] = data.map((d, i) => ({
      month: i + 1,
      incomeCents: d.incomeCents,
      expenseCents: d.expenseCents,
      profitCents: d.profitCents,
    }));
    const running = cumulativeProfit(buckets);
    return running.map((value, i) => ({
      label: data[i]!.label,
      valueCents: i <= lastActive ? value : null,
    }));
  }, [data, lastActive]);

  const chart = () => {
    switch (selected) {
      case 'profit':
        return (
          <MetricAreaChart
            data={singleSeries((d) => d.profitCents)}
            currency={currency}
            name={labels.profit}
            color={FINANCE_COLORS.profit}
          />
        );
      case 'income':
        return (
          <MetricAreaChart
            data={singleSeries((d) => d.incomeCents)}
            currency={currency}
            name={labels.income}
            color={FINANCE_COLORS.income}
          />
        );
      case 'expenses':
        return (
          <MetricAreaChart
            data={singleSeries((d) => d.expenseCents)}
            currency={currency}
            name={labels.expenses}
            color={FINANCE_COLORS.expense}
          />
        );
      case 'cashflow':
        return (
          <MetricAreaChart
            data={cashflowSeries}
            currency={currency}
            name={labels.cashflow}
            color={FINANCE_COLORS.profit}
          />
        );
      case 'incomeVsExpenses':
      default:
        return <MonthlyChart data={data} currency={currency} />;
    }
  };

  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle>{labels.title}</CardTitle>
        <div className="w-48 shrink-0">
          <Select
            value={selected}
            onChange={(e) => setSelected(e.target.value as ChartKey)}
            className="h-9"
            aria-label={labels.title}
          >
            {CHART_KEYS.map((key) => (
              <option key={key} value={key}>
                {labels[key]}
              </option>
            ))}
          </Select>
        </div>
      </CardHeader>
      <CardContent>{chart()}</CardContent>
    </Card>
  );
}
