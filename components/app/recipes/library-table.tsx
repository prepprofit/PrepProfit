'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, ArrowUpDown, Eye, Printer, Search, SlidersHorizontal, Trash2 } from 'lucide-react';
import type { LibraryRecipeRow } from '@/lib/data/recipe-library';
import { formatMoney } from '@/lib/format/money';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useActionError } from '@/lib/i18n/use-action-error';
import { deleteRecipeAction } from '@/app/(app)/recipes/actions';
import { cn } from '@/lib/utils';
import { RecipeQuickView } from './recipe-quick-view';
import { readRecipeListReturn, rememberRecipeListReturn, scrollContainer } from './recipe-list-return';

/**
 * Recipe browsing list. Each row: the recipe NAME (large; opens the recipe), cost per
 * kg (managers only — kitchen rows carry no `money` key at all; "—" with the reason
 * when it can't be calculated), then quick view, print and move-to-Trash. Nothing
 * else lives in the row — no yield, prices, margins or status badges.
 *
 * Rows arrive in recent-activity order (latest edit or open first). Search, sort and
 * the scroll position are remembered when a recipe is opened, so "Back to recipes"
 * returns to exactly this list.
 */

export type LibraryTableRow = Omit<LibraryRecipeRow, 'money'> & Partial<Pick<LibraryRecipeRow, 'money'>>;

type SortKey = 'recent' | 'name-asc' | 'name-desc' | 'cost-asc' | 'cost-desc';
const SORT_KEYS: SortKey[] = ['recent', 'name-asc', 'name-desc', 'cost-asc', 'cost-desc'];

type IssueKey = 'allergensUnreviewed' | 'nutritionIncomplete' | 'needsPricing' | 'missingFinishedWeight' | 'yieldReviewNeeded' | 'legacyLabourOrEnergy';

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function issuesOf(row: LibraryTableRow, showMoney: boolean): IssueKey[] {
  const issues: IssueKey[] = [];
  if (row.status.allergensUnreviewed) issues.push('allergensUnreviewed');
  if (row.status.nutritionIncomplete) issues.push('nutritionIncomplete');
  if (showMoney && row.money?.needsPricing) issues.push('needsPricing');
  if (row.status.missingFinishedWeight) issues.push('missingFinishedWeight');
  if (row.status.yieldReviewNeeded) issues.push('yieldReviewNeeded');
  if (showMoney && row.money?.legacyLabourOrEnergy) issues.push('legacyLabourOrEnergy');
  return issues;
}

export function LibraryTable({
  rows,
  showMoney,
  currency,
}: {
  /** Already in recent-activity order. */
  rows: LibraryTableRow[];
  showMoney: boolean;
  currency: string;
}) {
  const t = useTranslations('recipes.library');
  const tHome = useTranslations('recipes.home');
  const tIssues = useTranslations('recipes.issues');
  const tAllergens = useTranslations('allergens');
  const tRecipes = useTranslations('recipes');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const listHref = `${pathname}${searchParams.toString() ? `?${searchParams.toString()}` : ''}`;

  const [query, setQuery] = React.useState('');
  const [sort, setSort] = React.useState<SortKey>('recent');
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [allergenFilter, setAllergenFilter] = React.useState<Set<string>>(new Set());
  const [issueFilter, setIssueFilter] = React.useState<Set<IssueKey>>(new Set());

  // Coming back from a recipe: restore this list's search, sort and scroll.
  React.useEffect(() => {
    const saved = readRecipeListReturn();
    if (!saved || saved.href !== listHref) return;
    setQuery(saved.query);
    if (SORT_KEYS.includes(saved.sort as SortKey)) setSort(saved.sort as SortKey);
    const top = saved.scrollTop;
    requestAnimationFrame(() => scrollContainer()?.scrollTo({ top }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore once on mount
  }, []);

  const remember = React.useCallback(() => {
    rememberRecipeListReturn({ href: listHref, query, sort, scrollTop: scrollContainer()?.scrollTop ?? 0 });
  }, [listHref, query, sort]);

  const allergenOptions = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const chip of row.allergens) counts.set(chip.allergen, (counts.get(chip.allergen) ?? 0) + 1);
    }
    return [...counts.entries()].map(([allergen, count]) => ({ allergen, count }));
  }, [rows]);

  const issueOptions = React.useMemo(() => {
    const keys: IssueKey[] = [
      'allergensUnreviewed',
      'nutritionIncomplete',
      ...(showMoney ? (['needsPricing'] as const) : []),
      'missingFinishedWeight',
      'yieldReviewNeeded',
      ...(showMoney ? (['legacyLabourOrEnergy'] as const) : []),
    ];
    return keys
      .map((key) => ({ key, count: rows.filter((r) => issuesOf(r, showMoney).includes(key)).length }))
      .filter((o) => o.count > 0 || issueFilter.has(o.key));
  }, [rows, showMoney, issueFilter]);

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
      const ca = cost(a);
      const cb = cost(b);
      if (ca === null || cb === null) return Number(ca === null) - Number(cb === null) || collator.compare(a.name, b.name);
      return (sort === 'cost-asc' ? ca - cb : cb - ca) || collator.compare(a.name, b.name);
    });
  }, [rows, q, allergenFilter, issueFilter, sort, showMoney]);

  // ── Quick view + Trash ──
  const [quickViewId, setQuickViewId] = React.useState<string | null>(null);
  const [trashTarget, setTrashTarget] = React.useState<LibraryTableRow | null>(null);
  const [trashError, setTrashError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [hidden, setHidden] = React.useState<Set<string>>(new Set());
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const confirmTrash = () => {
    const target = trashTarget;
    if (!target) return;
    setTrashError(null);
    startTransition(async () => {
      const result = await deleteRecipeAction(target.id);
      if (!result.ok) {
        setTrashError(actionError(result.code));
        return;
      }
      setHidden((prev) => new Set(prev).add(target.id));
      setTrashTarget(null);
      setNotice(t('trashed', { name: target.name }));
      router.refresh();
    });
  };

  const headingSort = (key: 'name' | 'cost') =>
    setSort((current) =>
      key === 'name' ? (current === 'name-asc' ? 'name-desc' : 'name-asc') : current === 'cost-asc' ? 'cost-desc' : 'cost-asc',
    );
  const sortIcon = (key: 'name' | 'cost') => {
    const Icon = sort === `${key}-asc` ? ArrowUp : sort === `${key}-desc` ? ArrowDown : ArrowUpDown;
    return <Icon className={cn('size-3.5', !sort.startsWith(key) && 'opacity-40')} aria-hidden />;
  };
  const ariaSort = (key: 'name' | 'cost') =>
    sort === `${key}-asc` ? 'ascending' : sort === `${key}-desc` ? 'descending' : undefined;
  const activeFilters = allergenFilter.size + issueFilter.size;
  const shownRows = visibleRows.filter((r) => !hidden.has(r.id));

  const costReason = (row: LibraryTableRow): string => {
    if (row.status.missingFinishedWeight) return t('costReason.weight');
    if (row.money?.needsPricing) return t('costReason.prices');
    return t('costReason.incomplete');
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
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
          <Select id="library-sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="h-10 w-44">
            <option value="recent">{tHome('sort.recent')}</option>
            <option value="name-asc">{tHome('sort.name')}</option>
            <option value="name-desc">{tHome('sort.nameDesc')}</option>
            {showMoney && <option value="cost-asc">{tHome('sort.costAsc')}</option>}
            {showMoney && <option value="cost-desc">{tHome('sort.costDesc')}</option>}
          </Select>
          <Button type="button" variant="outline" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((v) => !v)} className="h-10 px-3">
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
            {issueOptions.length === 0 && <span className="text-xs text-muted-foreground">{t('filters.noIssues')}</span>}
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

      <Card className="overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="px-4 py-2.5 text-left font-medium text-muted-foreground" aria-sort={ariaSort('name')}>
                <button type="button" className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground" onClick={() => headingSort('name')}>
                  {t('columns.name')}
                  {sortIcon('name')}
                </button>
              </th>
              {showMoney && (
                <th className="px-3 py-2.5 text-right font-medium text-muted-foreground" aria-sort={ariaSort('cost')}>
                  <button type="button" className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground" onClick={() => headingSort('cost')}>
                    {t('columns.costPerKg')}
                    {sortIcon('cost')}
                  </button>
                </th>
              )}
              <th className="w-px py-2.5 pl-2 pr-3">
                <span className="sr-only">{t('columns.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shownRows.length === 0 ? (
              <tr>
                <td colSpan={showMoney ? 3 : 2} className="px-4 py-10 text-center text-muted-foreground">
                  {t('empty')}
                </td>
              </tr>
            ) : (
              shownRows.map((row) => {
                const cost = row.money?.costPerKgCents ?? null;
                return (
                  <tr key={row.id} className="border-b border-border/60 transition-colors last:border-b-0 hover:bg-surface-2/60">
                    <td className="px-4 py-4 align-middle">
                      <Link
                        href={`/recipes/${row.id}`}
                        onClick={remember}
                        className="block rounded text-lg font-medium leading-snug text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {row.name}
                      </Link>
                    </td>
                    {showMoney && (
                      <td className="whitespace-nowrap px-3 py-4 text-right align-middle tabular-nums">
                        {cost !== null ? (
                          <span className="text-base text-foreground">
                            {formatMoney(cost, currency)}
                            <span className="ml-0.5 text-xs text-muted-foreground">/kg</span>
                          </span>
                        ) : (
                          <span className="cursor-help text-base text-muted-foreground" title={costReason(row)}>
                            <span aria-hidden>—</span>
                            <span className="sr-only">{costReason(row)}</span>
                          </span>
                        )}
                      </td>
                    )}
                    <td className="py-4 pl-2 pr-3 align-middle">
                      <div className="flex items-center justify-end gap-0.5">
                        <IconButton label={t('actions.quickView', { name: row.name })} onClick={() => setQuickViewId(row.id)}>
                          <Eye className="size-[18px]" aria-hidden />
                        </IconButton>
                        <a
                          href={`/api/recipes/${row.id}/print/pdf`}
                          target="_blank"
                          rel="noopener"
                          aria-label={t('actions.print', { name: row.name })}
                          title={t('actions.printShort')}
                          className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <Printer className="size-[18px]" aria-hidden />
                        </a>
                        <IconButton
                          label={t('actions.trash', { name: row.name })}
                          onClick={() => {
                            setTrashError(null);
                            setTrashTarget(row);
                          }}
                        >
                          <Trash2 className="size-[18px]" aria-hidden />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </Card>

      <RecipeQuickView recipeId={quickViewId} onClose={() => setQuickViewId(null)} onOpen={remember} />

      <ConfirmDialog
        open={trashTarget !== null}
        title={tRecipes('deleteConfirm.title')}
        description={tRecipes('deleteConfirm.body', { name: trashTarget?.name ?? '' })}
        confirmLabel={tCommon('moveToTrash')}
        cancelLabel={tCommon('cancel')}
        destructive
        pending={pending}
        onConfirm={confirmTrash}
        onCancel={() => setTrashTarget(null)}
      >
        {trashError && (
          <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
            {trashError}
          </p>
        )}
      </ConfirmDialog>

      {notice && (
        <div role="status" className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl bg-foreground px-4 py-3 text-sm text-background shadow-lg">
          {notice}
        </div>
      )}
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-9 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

function FilterChip({ selected, onClick, label, count }: { selected: boolean; onClick: () => void; label: string; count: number }) {
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
