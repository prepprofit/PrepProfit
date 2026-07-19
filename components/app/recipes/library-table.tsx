'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import type { LibraryRecipeRow } from '@/lib/data/recipe-library';
import { formatMoney } from '@/lib/format/money';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * Recipes 2.0 library table (Fase 7 Slice 2, parity with `Recipes/1.png`).
 * Server-driven and read-only: the page ships the already-RBAC-stripped rows
 * (kitchen rows carry NO `money` key at all — the Cost/Price/Margin columns are
 * built only when `showMoney`), and a row click navigates to the recipe.
 * Search + sorting are client-side over the org's active recipes.
 */

/** What the table renders: the manager row with `money` optional (kitchen). */
export type LibraryTableRow = Omit<LibraryRecipeRow, 'money'> &
  Partial<Pick<LibraryRecipeRow, 'money'>>;

type TableMeta = {
  onOpen: (id: string) => void;
};

export function LibraryTable({
  rows,
  books,
  showMoney,
  currency,
}: {
  rows: LibraryTableRow[];
  books: { id: string; name: string }[];
  /** Manager only — kitchen rows have no money to show anyway. */
  showMoney: boolean;
  currency: string;
}) {
  const t = useTranslations('recipes.library');
  const tAllergens = useTranslations('allergens');
  const router = useRouter();
  const [query, setQuery] = React.useState('');
  const [sorting, setSorting] = React.useState<SortingState>([
    { id: 'name', desc: false },
  ]);

  const bookName = React.useMemo(
    () => new Map(books.map((b) => [b.id, b.name])),
    [books],
  );

  const q = query.trim().toLowerCase();
  const visibleRows = React.useMemo(
    () => (q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows),
    [rows, q],
  );

  const columns = React.useMemo<ColumnDef<LibraryTableRow>[]>(() => {
    const cols: ColumnDef<LibraryTableRow>[] = [
      {
        id: 'name',
        accessorKey: 'name',
        header: t('columns.name'),
        cell: ({ row }) => (
          <span className="font-medium text-foreground">
            {row.original.name}
          </span>
        ),
      },
      {
        id: 'books',
        header: t('columns.books'),
        enableSorting: false,
        cell: ({ row }) => {
          const names = row.original.bookIds
            .map((id) => bookName.get(id))
            .filter((n): n is string => n !== undefined);
          if (names.length === 0) {
            return <span className="text-muted-foreground">—</span>;
          }
          return (
            <span className="flex flex-wrap gap-1">
              {names.map((name) => (
                <span
                  key={name}
                  className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-foreground"
                >
                  {name}
                </span>
              ))}
            </span>
          );
        },
      },
      {
        id: 'yield',
        header: t('columns.yield'),
        enableSorting: false,
        cell: ({ row }) => {
          const r = row.original;
          return r.yieldQuantity != null && r.yieldUnit
            ? `${r.yieldQuantity} ${r.yieldUnit}`
            : t('portions', { count: r.yieldPortions });
        },
      },
      {
        id: 'allergens',
        header: t('columns.allergens'),
        enableSorting: false,
        cell: ({ row }) => {
          const chips = row.original.allergens;
          if (chips.length === 0) {
            // Never claim "allergen-free" — absence of data is not absence.
            return <span className="text-muted-foreground">—</span>;
          }
          return (
            <span className="flex flex-wrap gap-1">
              {chips.map((chip) => (
                <span
                  key={chip.allergen}
                  title={`${tAllergens(`presence.${chip.presence}`)}: ${tAllergens(`labels.${chip.allergen}`)}`}
                  className={cn(
                    'rounded-full px-2 py-0.5 text-xs',
                    chip.presence === 'contains'
                      ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'
                      : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
                  )}
                >
                  {tAllergens(`labels.${chip.allergen}`)}
                </span>
              ))}
            </span>
          );
        },
      },
      {
        id: 'status',
        header: t('columns.status'),
        enableSorting: false,
        cell: ({ row }) => {
          const r = row.original;
          const badges: string[] = [];
          if (r.status.allergensUnreviewed) badges.push(t('status.allergensUnreviewed'));
          if (r.status.nutritionIncomplete) badges.push(t('status.nutritionIncomplete'));
          if (r.status.noBook) badges.push(t('status.noBook'));
          if (showMoney && r.money?.needsPricing) badges.push(t('status.needsPricing'));
          if (showMoney && r.money && r.money.sellingPriceCents == null) {
            badges.push(t('status.noSellingPrice'));
          }
          if (badges.length === 0) {
            return <span className="text-muted-foreground">—</span>;
          }
          return (
            <span className="flex flex-wrap gap-1">
              {badges.map((label) => (
                <span
                  key={label}
                  className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
                >
                  {label}
                </span>
              ))}
            </span>
          );
        },
      },
    ];

    if (showMoney) {
      cols.push(
        {
          id: 'cost',
          accessorFn: (r) => r.money?.costPerPortionCents ?? null,
          header: t('columns.cost'),
          sortUndefined: 'last',
          cell: ({ row }) => {
            const cents = row.original.money?.costPerPortionCents;
            return cents != null ? (
              <span className="tabular-nums">{formatMoney(cents, currency)}</span>
            ) : (
              <span className="text-muted-foreground">—</span>
            );
          },
        },
        {
          id: 'price',
          accessorFn: (r) => r.money?.sellingPriceCents ?? null,
          header: t('columns.price'),
          cell: ({ row }) => {
            const cents = row.original.money?.sellingPriceCents;
            return cents != null ? (
              <span className="tabular-nums">{formatMoney(cents, currency)}</span>
            ) : (
              <span className="text-muted-foreground">—</span>
            );
          },
        },
        {
          id: 'margin',
          accessorFn: (r) => r.money?.marginPercent ?? null,
          header: t('columns.margin'),
          cell: ({ row }) => {
            const pct = row.original.money?.marginPercent;
            return pct != null ? (
              <span className="tabular-nums">{pct}%</span>
            ) : (
              <span className="text-muted-foreground">—</span>
            );
          },
        },
      );
    }
    return cols;
  }, [bookName, currency, showMoney, t, tAllergens]);

  const table = useReactTable({
    data: visibleRows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    meta: {
      onOpen: (id: string) => router.push(`/recipes/${id}`),
    } satisfies TableMeta,
  });

  return (
    <div className="flex flex-col gap-3">
      <Input
        aria-label={t('searchPlaceholder')}
        placeholder={t('searchPlaceholder')}
        className="max-w-xs"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="border-b border-border">
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const dir = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      className="px-3 py-2.5 text-left font-medium text-muted-foreground"
                    >
                      {canSort ? (
                        <button
                          type="button"
                          className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                          {dir === 'asc' ? (
                            <ArrowUp className="size-3.5" />
                          ) : dir === 'desc' ? (
                            <ArrowDown className="size-3.5" />
                          ) : (
                            <ArrowUpDown className="size-3.5 opacity-40" />
                          )}
                        </button>
                      ) : (
                        flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-3 py-8 text-center text-muted-foreground"
                >
                  {t('empty')}
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  tabIndex={0}
                  role="link"
                  aria-label={row.original.name}
                  className="cursor-pointer border-b border-border/60 transition-colors last:border-b-0 hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                  onClick={() => router.push(`/recipes/${row.original.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') router.push(`/recipes/${row.original.id}`);
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2.5 align-top">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
