import { formatMoney } from '@/lib/format/money';
import { cn } from '@/lib/utils';

export type CategoryDatum = {
  id: string;
  /** Already-resolved display name (i18n for predefined, literal for custom). */
  name: string;
  kind: 'income' | 'expense';
  totalCents: number;
};

/**
 * By-category totals as proportion bars (income = emerald, expense = orange).
 * Presentational and legible on mobile — the page resolves display names first.
 */
export function CategoryBreakdown({
  items,
  currency,
  emptyLabel,
}: {
  items: CategoryDatum[];
  currency: string;
  emptyLabel: string;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  const max = Math.max(...items.map((i) => i.totalCents), 1);

  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item.id} className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="truncate text-foreground">{item.name}</span>
            <span className="font-medium text-foreground">
              {formatMoney(item.totalCents, currency)}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
            <div
              className={cn(
                'h-full rounded-full',
                item.kind === 'income' ? 'bg-brand-500' : 'bg-accent-500',
              )}
              style={{ width: `${Math.round((item.totalCents / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
