import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { formatQuantity, type Dimension, type MeasurementSystem } from '@/lib/units';
import { cn } from '@/lib/utils';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export type LowStockItem = {
  id: string;
  name: string;
  dimension: Dimension;
  stockCanonical: number;
  /** The threshold the item fell to or below (always set for a low item). */
  thresholdCanonical: number;
};

/**
 * Ingredients at or below their low-stock threshold — the "to reorder" list.
 * Operational (no financial figures), so it renders for both manager and kitchen.
 * Quantities are formatted through the org measurement system. Presentational.
 */
export function LowStockCard({
  items,
  measurementSystem,
  title,
  emptyLabel,
  viewAllLabel,
  className,
}: {
  items: LowStockItem[];
  measurementSystem: MeasurementSystem;
  title: string;
  emptyLabel: string;
  viewAllLabel: string;
  className?: string;
}) {
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>{title}</CardTitle>
        <Link
          href="/inventory"
          className="flex items-center gap-1 text-xs font-medium text-accent-700 hover:underline"
        >
          {viewAllLabel}
          <ArrowRight className="size-3" />
        </Link>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyLabel}</p>
        ) : (
          <div className="divide-y divide-border">
            {items.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
              >
                <span className="flex-1 truncate text-sm text-foreground">
                  {item.name}
                </span>
                <span className="shrink-0 text-sm tabular-nums">
                  <span className="font-medium text-red-700 dark:text-red-300">
                    {formatQuantity(item.stockCanonical, item.dimension, measurementSystem)}
                  </span>
                  <span className="text-muted-foreground">
                    {' / '}
                    {formatQuantity(
                      item.thresholdCanonical,
                      item.dimension,
                      measurementSystem,
                    )}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
