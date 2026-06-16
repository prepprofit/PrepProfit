'use client';

import * as React from 'react';
import { ResponsiveContainer } from 'recharts';
import { cn } from '@/lib/utils';

/**
 * Lightweight chart primitives for shadcn-style charts on Recharts. Series
 * reference the categorical palette directly (fill/stroke="var(--color-chart-N)"),
 * so colours follow the design tokens in app/globals.css and switch with the
 * theme for free — no per-chart colour wiring needed.
 */

/** Categorical palette, in order, wired to the @theme chart tokens. */
export const CHART_COLORS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
  'var(--color-chart-6)',
] as const;

/** Semantic colours for finance series (emerald = positive, never orange). */
export const FINANCE_COLORS = {
  income: 'var(--color-chart-2)',
  expense: 'var(--color-chart-1)',
  profit: 'var(--color-chart-5)',
} as const;

/** Responsive frame: a fixed-height box wrapping Recharts' ResponsiveContainer. */
export function ChartContainer({
  className,
  children,
}: {
  className?: string;
  children: React.ReactElement;
}) {
  return (
    <div className={cn('h-64 w-full', className)}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

/** One series entry as Recharts injects it into a custom tooltip. */
type TooltipEntry = {
  name?: string | number;
  value?: number | string;
  color?: string;
};

/**
 * Themed tooltip body. Pass as `<Tooltip content={<ChartTooltipContent ... />} />`;
 * Recharts clones it with `active`/`payload`/`label`. `formatValue` renders each
 * numeric value (e.g. through formatMoney).
 */
export function ChartTooltipContent({
  active,
  payload,
  label,
  formatValue,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
  formatValue?: (value: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-md">
      {label != null && (
        <p className="mb-1 font-medium text-foreground">{label}</p>
      )}
      <ul className="flex flex-col gap-1">
        {payload.map((entry, index) => (
          <li key={index} className="flex items-center gap-2">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: entry.color }}
              aria-hidden
            />
            <span className="text-muted-foreground">{entry.name}</span>
            <span className="ml-auto font-medium text-foreground">
              {formatValue && typeof entry.value === 'number'
                ? formatValue(entry.value)
                : entry.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
