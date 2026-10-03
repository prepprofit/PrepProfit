'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Search } from 'lucide-react';
import type { PickerOption } from '@/lib/recipes/editor-model';
import { DIMENSION_LABEL } from '@/lib/recipes/editor-model';
import { cn } from '@/lib/utils';

export type SearchPick = { kind: 'ingredient' | 'component'; option: PickerOption };

type Result = SearchPick & { inRecipe: boolean };

const MAX_INGREDIENTS = 8;
const MAX_COMPONENTS = 4;

function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

/** 0 = name starts with the query, 1 = a word starts with it, 2 = contains it, null = no match. */
function rank(name: string, query: string): number | null {
  const n = normalize(name);
  if (n.startsWith(query)) return 0;
  if (n.split(/[\s,()/-]+/).some((w) => w.startsWith(query))) return 1;
  return n.includes(query) ? 2 : null;
}

function matches(options: PickerOption[], query: string, limit: number): PickerOption[] {
  if (query === '') return options.slice(0, limit);
  return options
    .map((o) => ({ o, r: rank(o.name, query) }))
    .filter((x): x is { o: PickerOption; r: number } => x.r !== null)
    .sort((a, b) => a.r - b.r || a.o.name.localeCompare(b.o.name))
    .slice(0, limit)
    .map((x) => x.o);
}

/**
 * "Find an ingredient…": one search field under the list for the business's own
 * ingredients — and its recipes, which can be used as sub-recipes. Arrow keys move,
 * Enter adds, Escape clears. The parent focuses the new row's quantity; the field is
 * cleared after every pick, so a repeated Enter never adds the same thing twice.
 */
export const IngredientSearch = React.forwardRef<
  HTMLInputElement,
  {
    ingredientOptions: PickerOption[];
    componentOptions: PickerOption[];
    usedIngredientIds: ReadonlySet<string>;
    usedComponentIds: ReadonlySet<string>;
    onPick: (pick: SearchPick) => void;
  }
>(function IngredientSearch({ ingredientOptions, componentOptions, usedIngredientIds, usedComponentIds, onPick }, ref) {
  const t = useTranslations('recipes.editor.ingredients');
  const listId = React.useId();
  const [query, setQuery] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const [openUp, setOpenUp] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);

  const q = normalize(query);
  const results: Result[] = React.useMemo(() => {
    const ingredients = matches(ingredientOptions, q, MAX_INGREDIENTS).map((option) => ({
      kind: 'ingredient' as const,
      option,
      inRecipe: usedIngredientIds.has(option.id),
    }));
    const components =
      q === ''
        ? []
        : matches(componentOptions, q, MAX_COMPONENTS).map((option) => ({
            kind: 'component' as const,
            option,
            inRecipe: usedComponentIds.has(option.id),
          }));
    return [...ingredients, ...components];
  }, [ingredientOptions, componentOptions, q, usedIngredientIds, usedComponentIds]);

  const showList = open && (q !== '' || results.length > 0);

  // Near the bottom of the screen (the field sticks there as the list grows), open
  // the suggestions upwards so they stay visible.
  const placeList = React.useCallback(() => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom;
    setOpenUp(below < 300 && rect.top > below);
  }, []);

  const pick = (result: Result | undefined) => {
    if (!result) return;
    onPick({ kind: result.kind, option: result.option });
    setQuery('');
    setActive(0);
    setOpen(false);
  };

  const firstComponent = results.findIndex((r) => r.kind === 'component');

  return (
    <div ref={wrapRef} className="relative">
      <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <input
        ref={ref}
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && results[active] ? `${listId}-${active}` : undefined}
        aria-label={t('searchLabel')}
        placeholder={t('search')}
        autoComplete="off"
        data-1p-ignore=""
        data-lpignore="true"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
          placeList();
        }}
        onFocus={() => {
          if (query !== '') {
            setOpen(true);
            placeList();
          }
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            placeList();
            if (!open) setOpen(true);
            else setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter') {
            if (showList && results.length > 0) {
              e.preventDefault();
              pick(results[active]);
            }
          } else if (e.key === 'Escape') {
            if (query !== '' || open) {
              e.preventDefault();
              setQuery('');
              setOpen(false);
            }
          }
        }}
        className="h-12 w-full rounded-xl border border-border bg-surface pl-10 pr-3.5 text-base text-foreground shadow-sm transition-colors placeholder:text-muted-foreground hover:border-muted-foreground/40 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {showList ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('searchLabel')}
          className={cn(
            'absolute inset-x-0 z-30 max-h-80 overflow-y-auto rounded-xl border border-border bg-surface p-1.5 shadow-lg',
            openUp ? 'bottom-full mb-2' : 'top-full mt-2',
          )}
        >
          {results.length === 0 ? (
            <li className="px-3 py-2.5 text-sm text-muted-foreground" role="presentation">
              {t('noMatches', { query: query.trim() })}
            </li>
          ) : (
            results.map((result, index) => (
              <React.Fragment key={`${result.kind}-${result.option.id}`}>
                {index === firstComponent ? (
                  <li role="presentation" className="px-3 pb-1 pt-2.5 text-xs font-medium text-muted-foreground">
                    {t('groupRecipes')}
                  </li>
                ) : null}
                <li
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(result)}
                  className={cn(
                    'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-base',
                    index === active ? 'bg-primary-soft text-primary-soft-foreground' : 'text-foreground',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{result.option.name}</span>
                  {result.kind === 'ingredient' && result.option.dimension && result.option.dimension !== 'weight' ? (
                    <span className="text-xs text-muted-foreground">{DIMENSION_LABEL[result.option.dimension]}</span>
                  ) : null}
                  {result.kind === 'component' ? (
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted-foreground">{t('subRecipe')}</span>
                  ) : null}
                  {result.inRecipe ? <span className="text-xs text-muted-foreground">{t('inRecipe')}</span> : null}
                </li>
              </React.Fragment>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
});
