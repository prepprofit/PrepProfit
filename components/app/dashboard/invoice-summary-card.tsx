import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { formatMoney } from '@/lib/format/money';
import { cn } from '@/lib/utils';
import type { InvoiceSummary } from '@/lib/calculations/invoice';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export type InvoiceSummaryLabels = {
  title: string;
  outstanding: string;
  overdue: string;
  drafts: string;
  issued: string;
  paid: string;
  viewAll: string;
};

/**
 * Accounts-receivable panel for the dashboard: the outstanding (issued, unpaid)
 * total up top, an overdue callout when any issued invoice is past due, and the
 * draft / issued / paid counts. Manager-only — the page renders it inside the
 * finance gate. Presentational; the page resolves all labels.
 */
export function InvoiceSummaryCard({
  summary,
  currency,
  labels,
  className,
}: {
  summary: InvoiceSummary;
  currency: string;
  labels: InvoiceSummaryLabels;
  className?: string;
}) {
  const counts: { key: string; label: string; value: number }[] = [
    { key: 'drafts', label: labels.drafts, value: summary.draftCount },
    { key: 'issued', label: labels.issued, value: summary.issuedCount },
    { key: 'paid', label: labels.paid, value: summary.paidCount },
  ];

  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>{labels.title}</CardTitle>
        <Link
          href="/invoices"
          className="flex items-center gap-1 text-xs font-medium text-accent-700 hover:underline"
        >
          {labels.viewAll}
          <ArrowRight className="size-3" />
        </Link>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            {labels.outstanding}
          </span>
          <span className="font-display text-2xl font-semibold tabular-nums text-foreground sm:text-3xl">
            {formatMoney(summary.outstandingCents, currency)}
          </span>
          {summary.overdueCents > 0 && (
            <span className="text-xs font-medium text-red-700 dark:text-red-300">
              {labels.overdue}: {formatMoney(summary.overdueCents, currency)}
            </span>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2 border-t border-border pt-3">
          {counts.map((c) => (
            <div key={c.key} className="flex flex-col gap-0.5">
              <span className="font-display text-lg font-semibold tabular-nums text-foreground">
                {c.value}
              </span>
              <span className="text-xs text-muted-foreground">{c.label}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
