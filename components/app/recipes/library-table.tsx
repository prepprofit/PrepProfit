'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useActionError } from '@/lib/i18n/use-action-error';
import { bulkTrashRecipesAction } from '@/app/(app)/recipes/book-actions';
import { cn } from '@/lib/utils';

/**
 * Recipes 2.0 library table (Fase 7 Slice 2, parity with `Recipes/1.png`).
 * Server-driven and read-only: the page ships the already-RBAC-stripped rows
 * (kitchen rows carry NO `money` key at all — the Cost/Price/Margin columns are
 * built only when `showMoney`), and a row click navigates to the recipe.
 * Search + sorting are client-side over the folder's active recipes. The rows arrive
 * in recent-activity order (latest edit or open first); with no column sort active
 * the table keeps that order, and clicking a heading sorts by that column instead.
 */

/** What the table renders: the manager row with `money` optional (kitchen). */
export type LibraryTableRow = Omit<LibraryRecipeRow, 'money'> &
  Partial<Pick<LibraryRecipeRow, 'money'>>;

type TableMeta = {
  onOpen: (id: string) => void;
};

export function LibraryTable({
  rows,
  showMoney,
  currency,
}: {
  /** Already in recent-activity order. */
  rows: LibraryTableRow[];
  /** Manager only — kitchen rows have no money to show anyway. */
  showMoney: boolean;
  currency: string;
}) {
  const t = useTranslations('recipes.library');
  const tHome = useTranslations('recipes.home');
  const tAllergens = useTranslations('allergens');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();
  const [query, setQuery] = React.useState('');
  // Empty = the rows' own recent-activity order.
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const sortChoice =
    sorting.length === 0
      ? 'recent'
      : sorting.length === 1 && sorting[0]?.id === 'name' && !sorting[0].desc
        ? 'name'
        : 'column';

  // ── Filters (Fase 7 Slice 3, parity with `Nutrition and label/6.png`) ──
  // Allergen filter: ANY selected slug present (contains OR may-contain).
  // Status filter: ANY selected flag set. Groups AND together with search.
  const [allergenFilter, setAllergenFilter] = React.useState<Set<string>>(
    new Set(),
  );
  const [statusFilter, setStatusFilter] = React.useState<Set<string>>(
    new Set(),
  );

  // Only allergens actually present in the current view are offered, each with
  // its contains / may-contain recipe counts.
  const allergenOptions = React.useMemo(() => {
    const counts = new Map<string, { contains: number; mayContain: number }>();
    for (const row of rows) {
      for (const chip of row.allergens) {
        const entry = counts.get(chip.allergen) ?? { contains: 0, mayContain: 0 };
        if (chip.presence === 'contains') entry.contains += 1;
        else entry.mayContain += 1;
        counts.set(chip.allergen, entry);
      }
    }
    return [...counts.entries()].map(([allergen, c]) => ({ allergen, ...c }));
  }, [rows]);

  const statusOptions = React.useMemo(() => {
    const flagOf = (row: LibraryTableRow, key: string): boolean => {
      if (key === 'allergensUnreviewed') return row.status.allergensUnreviewed;
      if (key === 'nutritionIncomplete') return row.status.nutritionIncomplete;
      if (key === 'needsPricing') return row.money?.needsPricing === true;
      if (key === 'noSellingPrice') {
        return row.money !== undefined && row.money.sellingPriceCents == null;
      }
      return false;
    };
    // Financial statuses exist only when the payload carries money (manager).
    const keys = [
      'allergensUnreviewed',
      'nutritionIncomplete',
      ...(showMoney ? ['needsPricing', 'noSellingPrice'] : []),
    ];
    return keys.map((key) => ({
      key,
      count: rows.filter((r) => flagOf(r, key)).length,
      flagOf,
    }));
  }, [rows, showMoney]);

  const toggleIn = (
    set: Set<string>,
    value: string,
    apply: (next: Set<string>) => void,
  ) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  };

  const q = query.trim().toLowerCase();
  const visibleRows = React.useMemo(() => {
    const statusFlag = statusOptions[0]?.flagOf;
    return rows.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q)) return false;
      if (
        allergenFilter.size > 0 &&
        !r.allergens.some((chip) => allergenFilter.has(chip.allergen))
      ) {
        return false;
      }
      if (
        statusFilter.size > 0 &&
        statusFlag &&
        ![...statusFilter].some((key) => statusFlag(r, key))
      ) {
        return false;
      }
      return true;
    });
  }, [rows, q, allergenFilter, statusFilter, statusOptions]);

  // ── Bulk selection (Slice 4) ──
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkError, setBulkError] = React.useState<string | null>(null);
  const [bulkNotice, setBulkNotice] = React.useState<string | null>(null);
  const [confirmTrash, setConfirmTrash] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runBulkTrash = () => {
    setBulkError(null);
    setBulkNotice(null);
    startTransition(async () => {
      const result = await bulkTrashRecipesAction({ recipeIds: [...selected] });
      if (result.ok) {
        setBulkNotice(
          t('bulk.trashDone', {
            trashed: result.data.trashed,
            blocked: result.data.blocked,
            skipped: result.data.skipped,
          }),
        );
        setSelected(new Set());
        router.refresh();
      } else {
        setBulkError(actionError(result.code));
      }
      setConfirmTrash(false);
    });
  };

  const allVisibleSelected =
    visibleRows.length > 0 && visibleRows.every((r) => selected.has(r.id));

  const columns = React.useMemo<ColumnDef<LibraryTableRow>[]>(() => {
    const cols: ColumnDef<LibraryTableRow>[] = [
      {
        id: 'select',
        enableSorting: false,
        header: () => (
          <input
            type="checkbox"
            aria-label={t('bulk.selectAll')}
            className="size-4 cursor-pointer accent-accent-700"
            checked={allVisibleSelected}
            onChange={() =>
              setSelected(
                allVisibleSelected
                  ? new Set()
                  : new Set(visibleRows.map((r) => r.id)),
              )
            }
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            aria-label={t('bulk.selectRow', { name: row.original.name })}
            className="size-4 cursor-pointer accent-accent-700"
            checked={selected.has(row.original.id)}
            onClick={(e) => e.stopPropagation()}
            onChange={() => toggleSelected(row.original.id)}
          />
        ),
      },
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
  }, [
    currency,
    showMoney,
    t,
    tAllergens,
    selected,
    allVisibleSelected,
    visibleRows,
  ]);

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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            aria-label={t('searchPlaceholder')}
            placeholder={t('searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="library-sort" className="shrink-0 text-sm text-muted-foreground">
            {tHome('sortLabel')}
          </label>
          <Select
            id="library-sort"
            value={sortChoice}
            onChange={(e) =>
              setSorting(e.target.value === 'name' ? [{ id: 'name', desc: false }] : [])
            }
            className="h-10 w-48"
          >
            <option value="recent">{tHome('sort.recent')}</option>
            <option value="name">{tHome('sort.name')}</option>
            {sortChoice === 'column' && <option value="column">{tHome('sort.column')}</option>}
          </Select>
        </div>
      </div>

      {allergenOptions.length > 0 && (
        <fieldset className="flex flex-wrap items-center gap-1.5">
          <legend className="sr-only">{t('filters.allergens')}</legend>
          <span aria-hidden className="text-xs font-medium text-muted-foreground">
            {t('filters.allergens')}
          </span>
          {allergenOptions.map((option) => {
            const selected = allergenFilter.has(option.allergen);
            return (
              <button
                key={option.allergen}
                type="button"
                aria-pressed={selected}
                title={t('filters.allergenCounts', {
                  contains: option.contains,
                  mayContain: option.mayContain,
                })}
                onClick={() =>
                  toggleIn(allergenFilter, option.allergen, setAllergenFilter)
                }
                className={cn(
                  'cursor-pointer rounded-full border px-2.5 py-1 text-xs transition-colors',
                  selected
                    ? 'border-accent-700 bg-accent-50 font-medium text-accent-700 dark:border-accent-300 dark:bg-accent-500/15 dark:text-accent-300'
                    : 'border-border text-muted-foreground hover:bg-surface-2 hover:text-foreground',
                )}
              >
                {tAllergens(`labels.${option.allergen}`)}
                <span className="ml-1 tabular-nums opacity-70">
                  {option.contains + option.mayContain}
                </span>
              </button>
            );
          })}
        </fieldset>
      )}

      <fieldset className="flex flex-wrap items-center gap-1.5">
        <legend className="sr-only">{t('filters.status')}</legend>
        <span aria-hidden className="text-xs font-medium text-muted-foreground">
          {t('filters.status')}
        </span>
        {statusOptions.map((option) => {
          const selected = statusFilter.has(option.key);
          return (
            <button
              key={option.key}
              type="button"
              aria-pressed={selected}
              onClick={() => toggleIn(statusFilter, option.key, setStatusFilter)}
              className={cn(
                'cursor-pointer rounded-full border px-2.5 py-1 text-xs transition-colors',
                selected
                  ? 'border-accent-700 bg-accent-50 font-medium text-accent-700 dark:border-accent-300 dark:bg-accent-500/15 dark:text-accent-300'
                  : 'border-border text-muted-foreground hover:bg-surface-2 hover:text-foreground',
              )}
            >
              {t(`status.${option.key}`)}
              <span className="ml-1 tabular-nums opacity-70">{option.count}</span>
            </button>
          );
        })}
      </fieldset>

      {(bulkError || bulkNotice) && (
        <div
          role={bulkError ? 'alert' : 'status'}
          className={cn(
            'rounded-lg border px-3 py-1.5 text-xs',
            bulkError
              ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
              : 'border-border bg-surface-2 text-muted-foreground',
          )}
        >
          {bulkError ?? bulkNotice}
        </div>
      )}

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
          <span className="text-sm text-muted-foreground">
            {t('bulk.selected', { count: selected.size })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-red-600 dark:text-red-400"
            disabled={pending}
            onClick={() => setConfirmTrash(true)}
          >
            {t('bulk.trash')}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmTrash}
        title={t('bulk.trashConfirm.title')}
        description={t('bulk.trashConfirm.body', { count: selected.size })}
        confirmLabel={tCommon('delete')}
        cancelLabel={tCommon('cancel')}
        destructive
        pending={pending}
        onConfirm={runBulkTrash}
        onCancel={() => setConfirmTrash(false)}
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
