'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, ArrowUpDown, Search, SlidersHorizontal } from 'lucide-react';
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
import { RecipeIssuesButton, type RecipeIssue } from './recipe-issues-button';

/**
 * Recipe browsing list. Deliberately calm: the recipe NAME leads each row; the only
 * figure is cost per kg (managers only — kitchen rows carry no `money` key at all);
 * anything that needs fixing sits behind a small "!" that explains itself on click.
 * Yield, allergen chips, selling price and margin live on the recipe page, not here.
 *
 * Rows arrive in recent-activity order (latest edit or open first); sorting by name
 * or cost per kg is a choice, and "Recent activity" returns to the arrival order.
 * Allergen / issue filters stay available behind "Filters".
 */

/** What the list renders: the manager row with `money` optional (kitchen). */
export type LibraryTableRow = Omit<LibraryRecipeRow, 'money'> &
  Partial<Pick<LibraryRecipeRow, 'money'>>;

type SortKey = 'recent' | 'name-asc' | 'name-desc' | 'cost-asc' | 'cost-desc';

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export function issuesOf(row: LibraryTableRow, showMoney: boolean): RecipeIssue[] {
  const issues: RecipeIssue[] = [];
  if (row.status.allergensUnreviewed) issues.push('allergensUnreviewed');
  if (row.status.nutritionIncomplete) issues.push('nutritionIncomplete');
  if (showMoney && row.money?.needsPricing) issues.push('needsPricing');
  if (row.status.missingFinishedWeight) issues.push('missingFinishedWeight');
  return issues;
}

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
  const tIssues = useTranslations('recipes.issues');
  const tAllergens = useTranslations('allergens');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();
  const [query, setQuery] = React.useState('');
  const [sort, setSort] = React.useState<SortKey>('recent');
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [allergenFilter, setAllergenFilter] = React.useState<Set<string>>(new Set());
  const [issueFilter, setIssueFilter] = React.useState<Set<RecipeIssue>>(new Set());

  const allergenOptions = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const chip of row.allergens) counts.set(chip.allergen, (counts.get(chip.allergen) ?? 0) + 1);
    }
    return [...counts.entries()].map(([allergen, count]) => ({ allergen, count }));
  }, [rows]);

  const issueOptions = React.useMemo(() => {
    const keys: RecipeIssue[] = [
      'allergensUnreviewed',
      'nutritionIncomplete',
      ...(showMoney ? (['needsPricing'] as const) : []),
      'missingFinishedWeight',
    ];
    return keys.map((key) => ({ key, count: rows.filter((r) => issuesOf(r, showMoney).includes(key)).length }));
  }, [rows, showMoney]);

  const toggle = <T,>(set: Set<T>, value: T, apply: (next: Set<T>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  };

  const q = query.trim().toLowerCase();
  const visibleRows = React.useMemo(() => {
    const filtered = rows.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q)) return false;
      if (allergenFilter.size > 0 && !r.allergens.some((chip) => allergenFilter.has(chip.allergen))) return false;
      if (issueFilter.size > 0) {
        const issues = issuesOf(r, showMoney);
        if (![...issueFilter].some((key) => issues.includes(key))) return false;
      }
      return true;
    });
    if (sort === 'recent') return filtered;
    const cost = (r: LibraryTableRow) => r.money?.costPerKgCents ?? null;
    return [...filtered].sort((a, b) => {
      if (sort === 'name-asc') return collator.compare(a.name, b.name);
      if (sort === 'name-desc') return collator.compare(b.name, a.name);
      // Unknown cost per kg sinks to the bottom in both directions.
      const ca = cost(a);
      const cb = cost(b);
      if (ca === null || cb === null) {
        return Number(ca === null) - Number(cb === null) || collator.compare(a.name, b.name);
      }
      return (sort === 'cost-asc' ? ca - cb : cb - ca) || collator.compare(a.name, b.name);
    });
  }, [rows, q, allergenFilter, issueFilter, sort, showMoney]);

  // ── Bulk selection ──
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkError, setBulkError] = React.useState<string | null>(null);
  const [bulkNotice, setBulkNotice] = React.useState<string | null>(null);
  const [confirmTrash, setConfirmTrash] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

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

  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every((r) => selected.has(r.id));
  const activeFilters = allergenFilter.size + issueFilter.size;

  const headingSort = (key: 'name' | 'cost') => {
    setSort((current) =>
      key === 'name'
        ? current === 'name-asc'
          ? 'name-desc'
          : 'name-asc'
        : current === 'cost-asc'
          ? 'cost-desc'
          : 'cost-asc',
    );
  };
  const sortIcon = (key: 'name' | 'cost') => {
    const Icon = sort === `${key}-asc` ? ArrowUp : sort === `${key}-desc` ? ArrowDown : ArrowUpDown;
    return <Icon className={cn('size-3.5', !sort.startsWith(key) && 'opacity-40')} aria-hidden />;
  };
  const ariaSort = (key: 'name' | 'cost') =>
    sort === `${key}-asc` ? 'ascending' : sort === `${key}-desc` ? 'descending' : undefined;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
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
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="library-sort" className="shrink-0 text-sm text-muted-foreground">
            {tHome('sortLabel')}
          </label>
          <Select
            id="library-sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="h-10 w-44"
          >
            <option value="recent">{tHome('sort.recent')}</option>
            <option value="name-asc">{tHome('sort.name')}</option>
            <option value="name-desc">{tHome('sort.nameDesc')}</option>
            {showMoney && <option value="cost-asc">{tHome('sort.costAsc')}</option>}
            {showMoney && <option value="cost-desc">{tHome('sort.costDesc')}</option>}
          </Select>
          <Button
            type="button"
            variant="outline"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((v) => !v)}
            className="h-10 px-3"
          >
            <SlidersHorizontal className="size-4" aria-hidden />
            {activeFilters > 0 ? t('filters.toggleActive', { count: activeFilters }) : t('filters.toggle')}
          </Button>
        </div>
      </div>

      {filtersOpen && (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3">
          <fieldset className="flex flex-wrap items-center gap-1.5">
            <legend className="sr-only">{t('filters.status')}</legend>
            <span aria-hidden className="text-xs font-medium text-muted-foreground">
              {t('filters.status')}
            </span>
            {issueOptions.map((option) => (
              <FilterChip
                key={option.key}
                selected={issueFilter.has(option.key)}
                onClick={() => toggle(issueFilter, option.key, setIssueFilter)}
                label={tIssues(`${option.key}.label`)}
                count={option.count}
              />
            ))}
          </fieldset>
          {allergenOptions.length > 0 && (
            <fieldset className="flex flex-wrap items-center gap-1.5">
              <legend className="sr-only">{t('filters.allergens')}</legend>
              <span aria-hidden className="text-xs font-medium text-muted-foreground">
                {t('filters.allergens')}
              </span>
              {allergenOptions.map((option) => (
                <FilterChip
                  key={option.allergen}
                  selected={allergenFilter.has(option.allergen)}
                  onClick={() => toggle(allergenFilter, option.allergen, setAllergenFilter)}
                  label={tAllergens(`labels.${option.allergen}`)}
                  count={option.count}
                />
              ))}
            </fieldset>
          )}
        </div>
      )}

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
          <span className="text-sm text-muted-foreground">{t('bulk.selected', { count: selected.size })}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-red-700 dark:text-red-300"
            disabled={pending}
            onClick={() => setConfirmTrash(true)}
          >
            {t('bulk.trash')}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            {tCommon('cancel')}
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

      <Card className="overflow-visible p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="w-10 py-2.5 pl-4 pr-1 text-left">
                <input
                  type="checkbox"
                  aria-label={t('bulk.selectAll')}
                  className="size-4 cursor-pointer accent-accent-700"
                  checked={allVisibleSelected}
                  onChange={() =>
                    setSelected(allVisibleSelected ? new Set() : new Set(visibleRows.map((r) => r.id)))
                  }
                />
              </th>
              <th className="px-3 py-2.5 text-left font-medium text-muted-foreground" aria-sort={ariaSort('name')}>
                <button
                  type="button"
                  className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground"
                  onClick={() => headingSort('name')}
                >
                  {t('columns.name')}
                  {sortIcon('name')}
                </button>
              </th>
              {showMoney && (
                <th className="px-3 py-2.5 text-right font-medium text-muted-foreground" aria-sort={ariaSort('cost')}>
                  <button
                    type="button"
                    className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground"
                    onClick={() => headingSort('cost')}
                  >
                    {t('columns.costPerKg')}
                    {sortIcon('cost')}
                  </button>
                </th>
              )}
              <th className="w-12 py-2.5 pl-1 pr-4">
                <span className="sr-only">{tIssues('title')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.length === 0 ? (
              <tr>
                <td colSpan={showMoney ? 4 : 3} className="px-4 py-10 text-center text-muted-foreground">
                  {t('empty')}
                </td>
              </tr>
            ) : (
              visibleRows.map((row) => {
                const cost = row.money?.costPerKgCents ?? null;
                return (
                  <tr
                    key={row.id}
                    tabIndex={0}
                    aria-label={row.name}
                    className="cursor-pointer border-b border-border/60 transition-colors last:border-b-0 hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                    onClick={() => router.push(`/recipes/${row.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') router.push(`/recipes/${row.id}`);
                    }}
                  >
                    <td className="py-3.5 pl-4 pr-1 align-middle">
                      <input
                        type="checkbox"
                        aria-label={t('bulk.selectRow', { name: row.name })}
                        className="size-4 cursor-pointer accent-accent-700"
                        checked={selected.has(row.id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(row.id)) next.delete(row.id);
                            else next.add(row.id);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td className="px-3 py-3.5 align-middle">
                      <span className="text-base font-medium leading-snug text-foreground">{row.name}</span>
                    </td>
                    {showMoney && (
                      <td className="whitespace-nowrap px-3 py-3.5 text-right align-middle tabular-nums">
                        {cost !== null ? (
                          <span className="text-foreground">
                            {formatMoney(cost, currency)}
                            <span className="ml-0.5 text-xs text-muted-foreground">/kg</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground" title={t('costUnknown')}>
                            —
                          </span>
                        )}
                      </td>
                    )}
                    <td className="py-3.5 pl-1 pr-4 text-right align-middle">
                      <RecipeIssuesButton name={row.name} issues={issuesOf(row, showMoney)} />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function FilterChip({
  selected,
  onClick,
  label,
  count,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'cursor-pointer rounded-full border px-2.5 py-1 text-xs transition-colors',
        selected
          ? 'border-accent-600 bg-accent-50 font-medium text-accent-800 dark:border-accent-400 dark:bg-accent-500/15 dark:text-accent-200'
          : 'border-border text-muted-foreground hover:bg-surface-2 hover:text-foreground',
      )}
    >
      {label}
      <span className="ml-1 tabular-nums opacity-70">{count}</span>
    </button>
  );
}
