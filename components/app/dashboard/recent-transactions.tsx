import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { formatMoney } from '@/lib/format/money';
import { cn } from '@/lib/utils';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { TransactionListItem } from '@/lib/data/transactions';

const shortDate = (d: string) => {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y!, m! - 1, day!).toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
  });
};

export function RecentTransactions({
  rows,
  currency,
  title,
  emptyLabel,
  viewAllLabel,
  className,
}: {
  rows: TransactionListItem[];
  currency: string;
  title: string;
  emptyLabel: string;
  viewAllLabel: string;
  className?: string;
}) {
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">{title}</CardTitle>
        <Link
          href="/transactions"
          className="flex items-center gap-1 text-xs font-medium text-accent-700 hover:underline"
        >
          {viewAllLabel}
          <ArrowRight className="size-3" />
        </Link>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyLabel}</p>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((row) => (
              <div
                key={row.id}
                className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
              >
                <span className="w-12 shrink-0 text-xs tabular-nums text-muted-foreground">
                  {shortDate(row.occurredOn)}
                </span>
                <span className="flex-1 truncate text-sm text-foreground">
                  {row.category.name}
                </span>
                <span
                  className={cn(
                    'text-sm font-medium tabular-nums',
                    row.type === 'income'
                      ? 'text-brand-700 dark:text-brand-300'
                      : 'text-red-600 dark:text-red-400',
                  )}
                >
                  {row.type === 'income' ? '+' : '−'}
                  {formatMoney(row.amountCents, currency)}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
