'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, ArrowUpDown, Crown, Lightbulb, TrendingDown } from 'lucide-react';
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import type {
  CatalogueSummary,
  HourlyRate,
  ProductProfit,
} from '@/lib/calculations/profit-hour';
import type { ProfitMissing } from '@/lib/profit/product';
import type { SaleUnit } from '@/lib/validation/profit';
import { formatMoney } from '@/lib/format/money';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  useFormatMinutes,
  VERDICT_TEXT,
  VerdictBadge,
  type VerdictOrIncomplete,
} from './profit-shared';

export type ProfitCatalogueRow = {
  id: string;
  name: string;
  saleUnit: SaleUnit | null;
  sellingPriceCents: number | null;
  missing: ProfitMissing[];
  profit: ProductProfit | null;
};

const FILTERS = ['all', 'hero', 'solid', 'fragile', 'losing', 'incomplete'] as const;
type Filter = (typeof FILTERS)[number];

/** Incomplete = missing data; null = computable but no hourly rate to judge against. */
const rowVerdict = (row: ProfitCatalogueRow): VerdictOrIncomplete | null =>
  row.profit ? row.profit.verdict : 'incomplete';

/** Numeric comparator over the Hour Engine result (incomplete rows are re-sunk after sorting). */
function profitSort(pick: (p: ProductProfit) => number | null) {
  return (a: { original: ProfitCatalogueRow }, b: { original: ProfitCatalogueRow }) => {
    const va = a.original.profit ? pick(a.original.profit) : null;
    const vb = b.original.profit ? pick(b.original.profit) : null;
    if (va === null && vb === null) return 0;
    if (va === null) return -1;
    if (vb === null) return 1;
    return va - vb;
  };
}

/**
 * Catalogue ranking (Profit section, Part C). Summary block (top heroes, below-floor
 * products, the single biggest lever) above a TanStack table ranked by €/hour,
 * sortable per column and filterable by verdict. Rows open the calculator.
 */
export function ProfitCatalogue({
  rows,
  summary,
  rate,
  currency,
}: {
  rows: ProfitCatalogueRow[];
  summary: CatalogueSummary;
  rate: HourlyRate | null;
  currency: string;
}) {
  const t = useTranslations('profit');
  const router = useRouter();
  const formatMinutes = useFormatMinutes();
  const money = React.useCallback((cents: number) => formatMoney(cents, currency), [currency]);

  const [filter, setFilter] = React.useState<Filter>('all');
  const [sorting, setSorting] = React.useState<SortingState>([
    { id: 'euroPerHour', desc: true },
  ]);

  const filtered = React.useMemo(
    () => (filter === 'all' ? rows : rows.filter((r) => rowVerdict(r) === filter)),
    [rows, filter],
  );
  const incompleteCount = rows.filter((r) => r.profit === null).length;

  const columns = React.useMemo<ColumnDef<ProfitCatalogueRow>[]>(
    () => [
      {
        id: 'name',
        accessorKey: 'name',
        header: t('table.product'),
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-foreground">{row.original.name}</span>
            {row.original.missing.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {t('table.missingPrefix', {
                  items: row.original.missing.map((m) => t(`table.missing.${m}`)).join(', '),
                })}
              </span>
            )}
          </div>
        ),
      },
      {
        id: 'varCost',
        header: t('table.varCost'),
        sortingFn: profitSort((p) => p.variableCostPerUnitCents),
        accessorFn: (r) => r.profit?.variableCostPerUnitCents ?? null,
        cell: ({ row }) =>
          row.original.profit ? money(row.original.profit.variableCostPerUnitCents) : '—',
      },
      {
        id: 'timePerUnit',
        header: t('table.timePerUnit'),
        sortingFn: profitSort((p) => p.minutesPerUnit),
        accessorFn: (r) => r.profit?.minutesPerUnit ?? null,
        cell: ({ row }) =>
          row.original.profit ? formatMinutes(row.original.profit.minutesPerUnit) : '—',
      },
      {
        id: 'floorPrice',
        header: t('table.floorPrice'),
        sortingFn: profitSort((p) => p.floorPriceCents),
        accessorFn: (r) => r.profit?.floorPriceCents ?? null,
        cell: ({ row }) => {
          const p = row.original.profit;
          if (!p || p.floorPriceCents === null) return '—';
          return (
            <span className={cn(p.flags.includes('belowFloor') && 'text-red-700 dark:text-red-300')}>
              {money(p.floorPriceCents)}
            </span>
          );
        },
      },
      {
        id: 'margin',
        header: t('table.margin'),
        sortingFn: profitSort((p) => p.marginBps),
        accessorFn: (r) => r.profit?.marginBps ?? null,
        cell: ({ row }) => {
          const bps = row.original.profit?.marginBps;
          return bps != null ? (
            <span className="text-muted-foreground">{(bps / 100).toFixed(1)}%</span>
          ) : (
            '—'
          );
        },
      },
      {
        id: 'euroPerHour',
        header: t('table.euroPerHour'),
        sortingFn: profitSort((p) => p.euroPerHourCents),
        accessorFn: (r) => r.profit?.euroPerHourCents ?? null,
        cell: ({ row }) => {
          const p = row.original.profit;
          if (!p) return '—';
          return (
            <span className={cn('font-semibold', VERDICT_TEXT[rowVerdict(row.original) ?? 'solid'])}>
              {t('calc.perHour', { amount: money(p.euroPerHourCents) })}
            </span>
          );
        },
      },
      {
        id: 'verdict',
        header: t('table.verdict'),
        enableSorting: false,
        cell: ({ row }) => {
          const verdict = rowVerdict(row.original);
          return verdict ? <VerdictBadge verdict={verdict} /> : '—';
        },
      },
    ],
    [t, money, formatMinutes],
  );

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    // Numbers rank best-first on the first click.
    sortDescFirst: true,
  });

  // TanStack flips the comparator for desc, which would float incomplete rows to the
  // top; re-sink them after sorting so the ranking always ends with "needs data".
  const tableRows = table.getRowModel().rows;
  const orderedRows = [
    ...tableRows.filter((r) => r.original.profit !== null),
    ...tableRows.filter((r) => r.original.profit === null),
  ];

  return (
    <div className="flex flex-col gap-5">
      {rate ? (
        <Card className="border-transparent bg-gradient-to-br from-accent-100 to-accent-300 text-primary-soft-foreground shadow-lg shadow-accent-500/20">
          <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-1">
              <p className="font-display text-xl font-semibold leading-tight sm:text-2xl">
                {t('rate.headline', { amount: money(rate.trueHourlyRateCents) })}
              </p>
              <p className="text-sm text-primary-soft-foreground/80">
                {t('rate.breakdown', {
                  fixed: money(rate.fixedCostPerHourCents),
                  owner: money(rate.ownerTargetIncomePerHourCents),
                })}
              </p>
            </div>
            <Link
              href="/profit/rate"
              className="inline-flex h-9 w-fit shrink-0 items-center rounded-full bg-white/60 px-4 text-sm font-medium text-primary-soft-foreground hover:bg-white/80"
            >
              {t('rate.edit')}
            </Link>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">{t('rate.notConfigured')}</p>
            <Link
              href="/profit/rate"
              className="inline-flex h-10 w-fit shrink-0 items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary-hover"
            >
              {t('rate.setUp')}
            </Link>
          </CardContent>
        </Card>
      )}

      {rate && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Card>
            <CardContent className="flex flex-col gap-3 pt-6">
              <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Crown className="size-4 text-brand-700 dark:text-brand-300" />
                {t('summary.heroes')}
              </span>
              {summary.heroes.length > 0 ? (
                <ol className="flex flex-col gap-1.5 text-sm">
                  {summary.heroes.map((row) => (
                    <li key={row.id} className="flex items-center justify-between gap-2">
                      <Link href={`/profit/${row.id}`} className="truncate hover:underline">
                        {row.name}
                      </Link>
                      <span className="shrink-0 font-semibold tabular-nums text-brand-700 dark:text-brand-300">
                        {row.profit && t('calc.perHour', { amount: money(row.profit.euroPerHourCents) })}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-muted-foreground">{t('summary.heroesEmpty')}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-col gap-3 pt-6">
              <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <TrendingDown className="size-4 text-red-700 dark:text-red-300" />
                {t('summary.belowFloor')}
              </span>
              {summary.belowFloor.length > 0 ? (
                <>
                  <p className="font-display text-2xl font-semibold text-red-700 dark:text-red-300">
                    {t('summary.belowFloorCount', { count: summary.belowFloor.length })}
                  </p>
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {summary.belowFloor.map((r) => r.name).join(', ')}
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">{t('summary.belowFloorEmpty')}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-col gap-3 pt-6">
              <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Lightbulb className="size-4 text-accent-700 dark:text-accent-300" />
                {t('summary.lever')}
              </span>
              {summary.lever ? (
                <Link href={`/profit/${summary.lever.productId}`} className="text-sm hover:underline">
                  {summary.lever.kind === 'reprice'
                    ? t('summary.leverReprice', {
                        name: summary.lever.name,
                        from: money(summary.lever.fromCents),
                        to: money(summary.lever.toCents),
                        gain: money(summary.lever.hourGainCents),
                      })
                    : t('summary.leverRaise', {
                        name: summary.lever.name,
                        pct: summary.lever.riseBps / 100,
                        gain: money(summary.lever.hourGainCents),
                      })}
                </Link>
              ) : (
                <p className="text-sm text-muted-foreground">{t('summary.leverEmpty')}</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex w-full flex-col gap-1.5 sm:w-48">
          <label htmlFor="profit-filter" className="text-sm font-medium text-foreground">
            {t('table.filterLabel')}
          </label>
          <Select
            id="profit-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value as Filter)}
          >
            {FILTERS.filter((f) => rate || f === 'all' || f === 'incomplete').map((f) => (
              <option key={f} value={f}>
                {f === 'all' ? t('table.all') : t(`verdict.${f}`)}
              </option>
            ))}
          </Select>
        </div>
        {incompleteCount > 0 && (
          <p className="text-sm text-muted-foreground">
            {t('summary.incompleteCount', { count: incompleteCount })}
          </p>
        )}
      </div>

      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[52rem] text-sm">
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
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {dir === 'asc' ? (
                            <ArrowUp className="size-3.5" />
                          ) : dir === 'desc' ? (
                            <ArrowDown className="size-3.5" />
                          ) : (
                            <ArrowUpDown className="size-3.5 opacity-40" />
                          )}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {orderedRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-muted-foreground">
                  {rows.length === 0 ? t('table.empty') : t('table.noMatches')}
                </td>
              </tr>
            ) : (
              orderedRows.map((row) => (
                <tr
                  key={row.id}
                  tabIndex={0}
                  role="link"
                  aria-label={row.original.name}
                  className="cursor-pointer border-b border-border/60 transition-colors last:border-b-0 hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                  onClick={() => router.push(`/profit/${row.original.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') router.push(`/profit/${row.original.id}`);
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2.5 align-top tabular-nums">
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
