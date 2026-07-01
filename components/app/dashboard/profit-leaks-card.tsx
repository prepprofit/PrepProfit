import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { ProfitLeakSeverity } from '@/lib/calculations/profit-leaks';

export type ProfitLeakStat = {
  label: string;
  tone: 'critical' | 'warning' | 'muted';
};

export type ProfitLeakRow = {
  /** The finding fingerprint — stable key. */
  id: string;
  label: string;
  href: string;
  severity: ProfitLeakSeverity;
};

const DOT: Record<ProfitLeakSeverity, string> = {
  critical: 'bg-red-500',
  warning: 'bg-amber-500',
  info: 'bg-muted-foreground/50',
};

const STAT_TONE: Record<ProfitLeakStat['tone'], string> = {
  critical: 'text-red-700 dark:text-red-300',
  warning: 'text-amber-700 dark:text-amber-300',
  muted: 'text-muted-foreground',
};

/**
 * Profit leaks — the deterministic margin-risk card (Sprint 1, Slice 1.3).
 * Manager-only: the dashboard page renders it only inside its manager-gated
 * region, never for kitchen. Purely presentational — the page resolves findings
 * (loadProfitLeaks), counts and localized labels, so this stays an i18n-free view.
 * Each row links to the source recipe, menu or ingredient.
 */
export function ProfitLeaksCard({
  title,
  emptyLabel,
  stats,
  rows,
  viewAllHref,
  viewAllLabel,
  className,
}: {
  title: string;
  emptyLabel: string;
  stats: ProfitLeakStat[];
  rows: ProfitLeakRow[];
  /** When set, a footer link into the full Profit Insight Inbox (Sprint 4). */
  viewAllHref?: string;
  viewAllLabel?: string;
  className?: string;
}) {
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyLabel}</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-medium">
              {stats.map((stat) => (
                <span key={stat.label} className={STAT_TONE[stat.tone]}>
                  {stat.label}
                </span>
              ))}
            </div>
            <div className="divide-y divide-border">
              {rows.map((row) => (
                <Link
                  key={row.id}
                  href={row.href}
                  className="group flex items-center gap-2.5 py-2.5 first:pt-0 last:pb-0"
                >
                  <span
                    className={cn('size-2 shrink-0 rounded-full', DOT[row.severity])}
                    aria-hidden
                  />
                  <span className="flex-1 truncate text-sm text-foreground">
                    {row.label}
                  </span>
                  <ArrowRight className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </Link>
              ))}
            </div>
            {viewAllHref && viewAllLabel && (
              <Link
                href={viewAllHref}
                className="mt-auto inline-flex items-center gap-1 pt-1 text-sm font-medium text-accent-700 hover:underline dark:text-accent-300"
              >
                {viewAllLabel}
                <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
