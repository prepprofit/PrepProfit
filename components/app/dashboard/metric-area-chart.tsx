'use client';

import { useId } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ChartContainer,
  ChartTooltipContent,
} from '@/components/ui/chart';
import { usePrefersReducedMotion } from '@/lib/hooks/use-prefers-reduced-motion';
import { formatMoney, formatMoneyCompact } from '@/lib/format/money';

export type MetricDatum = {
  /** Short month label, e.g. "Jan". */
  label: string;
  /** Money in cents, or null to break the line (e.g. months with no activity). */
  valueCents: number | null;
};

/**
 * A single smooth-gradient money series by month — the building block for the
 * dashboard's selectable analytics card (profit, revenue, expenses, cash flow).
 * Compact-formatted Y axis, precise tooltip, semantic colour passed in. Null
 * points break the line (`connectNulls={false}`) so it stops at the last real
 * month instead of flat-lining into the future.
 */
export function MetricAreaChart({
  data,
  currency,
  name,
  color,
}: {
  data: MetricDatum[];
  currency: string;
  name: string;
  color: string;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const gradientId = useId();
  const fmt = (value: number) => formatMoney(value, currency);
  const fmtCompact = (value: number) => formatMoneyCompact(value, currency);

  return (
    <ChartContainer className="h-72">
      <AreaChart data={data} margin={{ top: 12, right: 8, bottom: 0, left: 4 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.28} />
            <stop offset="95%" stopColor={color} stopOpacity={0.02} />
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
          cursor={{ stroke: 'var(--color-border)', strokeWidth: 1 }}
          content={<ChartTooltipContent formatValue={fmt} />}
        />
        <Area
          type="monotone"
          dataKey="valueCents"
          name={name}
          stroke={color}
          strokeWidth={2.5}
          fill={`url(#${gradientId})`}
          connectNulls={false}
          dot={false}
          activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--color-surface)' }}
          isAnimationActive={!reducedMotion}
        />
      </AreaChart>
    </ChartContainer>
  );
}
