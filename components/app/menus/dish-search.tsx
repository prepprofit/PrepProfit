'use client';

import * as React from 'react';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';

export type DishSearchOption = { id: string; name: string; hint: string };

const MAX_RESULTS = 8;

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

/**
 * The search field under the Recipes / Direct ingredients list. Arrow keys move,
 * Enter adds, Escape clears; the parent focuses the picked row's quantity (a repeated
 * pick focuses the row already in the dish). Opens upwards near the bottom of the
 * screen so the suggestions stay visible on a tablet.
 */
export const DishSearch = React.forwardRef<
  HTMLInputElement,
  {
    options: DishSearchOption[];
    usedIds: ReadonlySet<string>;
    placeholder: string;
    label: string;
    noMatches: (query: string) => string;
    addedLabel: string;
    onPick: (id: string) => void;
  }
>(function DishSearch({ options, usedIds, placeholder, label, noMatches, addedLabel, onPick }, ref) {
  const listId = React.useId();
  const [query, setQuery] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const [openUp, setOpenUp] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);

  const q = normalize(query);
  const results = React.useMemo(() => {
    if (q === '') return options.slice(0, MAX_RESULTS);
    return options
      .map((o) => ({ o, r: rank(o.name, q) }))
      .filter((x): x is { o: DishSearchOption; r: number } => x.r !== null)
      .sort((a, b) => a.r - b.r || a.o.name.localeCompare(b.o.name))
      .slice(0, MAX_RESULTS)
      .map((x) => x.o);
  }, [options, q]);
  const showList = open && (q !== '' || results.length > 0);

  const placeList = React.useCallback(() => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom;
    setOpenUp(below < 300 && rect.top > below);
  }, []);

  const pick = (option: DishSearchOption | undefined) => {
    if (!option) return;
    onPick(option.id);
    setQuery('');
    setActive(0);
    setOpen(false);
  };

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
        aria-label={label}
        placeholder={placeholder}
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
            // Never submits the dish form from the search field.
            e.preventDefault();
            if (showList) pick(results[active]);
          } else if (e.key === 'Escape') {
            if (query !== '' || open) {
              e.preventDefault();
              setQuery('');
              setOpen(false);
            }
          }
        }}
        className="h-12 w-full rounded-xl border border-border bg-surface pl-10 pr-3.5 text-base text-foreground transition-colors placeholder:text-muted-foreground hover:border-muted-foreground/40 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {showList ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          className={cn(
            'absolute inset-x-0 z-30 max-h-80 overflow-y-auto rounded-xl border border-border bg-surface p-1.5 shadow-lg',
            openUp ? 'bottom-full mb-2' : 'top-full mt-2',
          )}
        >
          {results.length === 0 ? (
            <li className="px-3 py-2.5 text-sm text-muted-foreground" role="presentation">
              {noMatches(query.trim())}
            </li>
          ) : (
            results.map((option, index) => (
              <li
                key={option.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(option)}
                className={cn(
                  'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-base',
                  index === active ? 'bg-primary-soft text-primary-soft-foreground' : 'text-foreground',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{option.name}</span>
                {usedIds.has(option.id) ? (
                  <span className="shrink-0 text-xs text-muted-foreground">{addedLabel}</span>
                ) : (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{option.hint}</span>
                )}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
});
