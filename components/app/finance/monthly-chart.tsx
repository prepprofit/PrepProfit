'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ChartContainer,
  ChartTooltipContent,
  FINANCE_COLORS,
} from '@/components/ui/chart';
import { formatMoney, formatMoneyCompact } from '@/lib/format/money';

export type MonthlyDatum = {
  /** Short month label, e.g. "Jan". */
  label: string;
  incomeCents: number;
  expenseCents: number;
  profitCents: number;
};

/** Respects the OS "reduce motion" setting — disables Recharts' entry animation. */
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/**
 * Income vs expense (gradient bars) with a profit overlay (smooth line) by month —
 * the central finance chart, reused on the dashboard and the annual financials
 * view. Values are integer cents; the axis uses a compact format and the tooltip
 * the precise one. The profit line is nulled for months with no activity so it
 * stops cleanly at the last real month instead of flat-lining across the future.
 */
export function MonthlyChart({
  data,
  currency,
}: {
  data: MonthlyDatum[];
  currency: string;
}) {
  const t = useTranslations('finance.dashboard');
  const reducedMotion = usePrefersReducedMotion();
  const fmt = (value: number) => formatMoney(value, currency);
  const fmtCompact = (value: number) => formatMoneyCompact(value, currency);

  // Null the profit point for months with no income AND no expense, so the line
  // breaks there (connectNulls=false) rather than drawing through empty months.
  const series = useMemo(
    () =>
      data.map((d) => ({
        ...d,
        profitPoint:
          d.incomeCents === 0 && d.expenseCents === 0 ? null : d.profitCents,
      })),
    [data],
  );

  return (
    <ChartContainer className="h-72">
      <ComposedChart
        data={series}
        margin={{ top: 12, right: 8, bottom: 0, left: 4 }}
        barGap={4}
        barCategoryGap="28%"
      >
        <defs>
          <linearGradient id="fill-income" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={FINANCE_COLORS.income} stopOpacity={0.95} />
            <stop offset="100%" stopColor={FINANCE_COLORS.income} stopOpacity={0.55} />
          </linearGradient>
          <linearGradient id="fill-expense" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={FINANCE_COLORS.expense} stopOpacity={0.95} />
            <stop offset="100%" stopColor={FINANCE_COLORS.expense} stopOpacity={0.55} />
          </linearGradient>
        </defs>

        <CartesianGrid
          vertical={false}
          stroke="var(--color-border)"
          strokeDasharray="3 3"
        />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
        />
        <YAxis
          width={56}
          tickFormatter={fmtCompact}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
        />
        <ReferenceLine y={0} stroke="var(--color-border)" strokeWidth={1} />
        <Tooltip
          cursor={{ fill: 'var(--color-surface-2)', opacity: 0.5, radius: 6 }}
          content={<ChartTooltipContent formatValue={fmt} />}
        />
        <Legend
          verticalAlign="top"
          align="right"
          height={28}
          iconType="circle"
          iconSize={8}
          wrapperStyle={{ fontSize: 12, color: 'var(--color-muted-foreground)' }}
        />
        <Bar
          dataKey="incomeCents"
          name={t('income')}
          fill="url(#fill-income)"
          radius={[6, 6, 0, 0]}
          maxBarSize={28}
          isAnimationActive={!reducedMotion}
        />
        <Bar
          dataKey="expenseCents"
          name={t('expenses')}
          fill="url(#fill-expense)"
          radius={[6, 6, 0, 0]}
          maxBarSize={28}
          isAnimationActive={!reducedMotion}
        />
        <Line
          type="monotone"
          dataKey="profitPoint"
          name={t('profit')}
          stroke={FINANCE_COLORS.profit}
          strokeWidth={2.5}
          connectNulls={false}
          dot={{ r: 3, fill: FINANCE_COLORS.profit, strokeWidth: 0 }}
          activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--color-surface)' }}
          isAnimationActive={!reducedMotion}
        />
      </ComposedChart>
    </ChartContainer>
  );
}
