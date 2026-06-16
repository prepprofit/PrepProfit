import { formatMoney } from '@/lib/format/money';

export type TopProductDatum = {
  recipeId: string;
  name: string;
  totalCents: number;
};

/** Income grouped by linked recipe — a ranked list (highest first). */
export function TopProducts({
  products,
  currency,
  emptyLabel,
}: {
  products: TopProductDatum[];
  currency: string;
  emptyLabel: string;
}) {
  if (products.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  return (
    <ul className="flex flex-col gap-3">
      {products.map((product) => (
        <li
          key={product.recipeId}
          className="flex items-center justify-between gap-2 text-sm"
        >
          <span className="truncate text-foreground">{product.name}</span>
          <span className="font-medium text-foreground">
            {formatMoney(product.totalCents, currency)}
          </span>
        </li>
      ))}
    </ul>
  );
}
