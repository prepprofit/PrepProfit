'use client';

import { useTranslations } from 'next-intl';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ChartContainer,
  ChartTooltipContent,
  FINANCE_COLORS,
} from '@/components/ui/chart';
import { formatMoney } from '@/lib/format/money';

export type MonthlyDatum = {
  /** Short month label, e.g. "Jan". */
  label: string;
  incomeCents: number;
  expenseCents: number;
  profitCents: number;
};

/**
 * Income vs expense (bars) with a profit overlay (line) by month — the central
 * finance chart, reused on the dashboard and the annual financials view. Values
 * are integer cents; axis and tooltip format them through formatMoney.
 */
export function MonthlyChart({
  data,
  currency,
}: {
  data: MonthlyDatum[];
  currency: string;
}) {
  const t = useTranslations('finance.dashboard');
  const fmt = (value: number) => formatMoney(value, currency);

  return (
    <ChartContainer>
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid
          vertical={false}
          stroke="var(--color-border)"
          strokeDasharray="3 3"
        />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
        />
        <YAxis
          width={72}
          tickFormatter={fmt}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
        />
        <Tooltip
          cursor={{ fill: 'var(--color-surface-2)' }}
          content={<ChartTooltipContent formatValue={fmt} />}
        />
        <Bar
          dataKey="incomeCents"
          name={t('income')}
          fill={FINANCE_COLORS.income}
          radius={[4, 4, 0, 0]}
        />
        <Bar
          dataKey="expenseCents"
          name={t('expenses')}
          fill={FINANCE_COLORS.expense}
          radius={[4, 4, 0, 0]}
        />
        <Line
          dataKey="profitCents"
          name={t('profit')}
          stroke={FINANCE_COLORS.profit}
          strokeWidth={2}
          dot={false}
        />
      </ComposedChart>
    </ChartContainer>
  );
}
