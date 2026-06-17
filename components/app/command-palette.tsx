'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Building2,
  Carrot,
  ChefHat,
  FileText,
  LayoutGrid,
  Loader2,
  Receipt,
  Search,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { MIN_QUERY_LEN } from '@/lib/search/ranking';
import { useActionError } from '@/lib/i18n/use-action-error';
import { globalSearchAction } from '@/app/(app)/search/actions';
import { cn } from '@/lib/utils';
import type { ActionErrorCode } from '@/lib/action-result';
import type {
  GroupedSearchResults,
  SearchEntityType,
} from '@/lib/search/types';

/** Icon per entity group (cosmetic). */
const GROUP_ICON: Record<
  SearchEntityType,
  React.ComponentType<{ className?: string }>
> = {
  recipe: ChefHat,
  ingredient: Carrot,
  transaction: Receipt,
  invoice: FileText,
  customer: Building2,
};

const EMPTY: GroupedSearchResults = { groups: [] };

/** Per-group cap of the mixed "All" view (mirrors the server default). At or above
 *  it, a "Show more" affordance switches to that entity's deeper single-type view. */
const COLLAPSED_PER_ENTITY = 5;

/** Shared keycap style for the inline keyboard hints. */
const KBD =
  'inline-flex min-w-[1.25rem] items-center justify-center rounded border border-border bg-surface-2 px-1 py-0.5 font-mono text-[10px] leading-none text-muted-foreground';

type FilterDef = {
  type: SearchEntityType | null;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
};

/**
 * ⌘K global search palette (Sprint 2.7, two-panel Spotlight redesign). Debounced,
 * server-driven (cmdk runs `shouldFilter={false}` — results arrive ranked from
 * `globalSearchAction`), with a stale-response guard so out-of-order responses
 * can't overwrite fresh ones. Open state is owned by the app shell; RBAC is
 * enforced on the server (a kitchen user never receives a transactions group, and
 * the Transactions filter pill is hidden for them).
 */
export function CommandPalette({
  open,
  onOpenChange,
  canSeeFinance,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Hides the Transactions pill + finance placeholder; the server is the real gate. */
  canSeeFinance: boolean;
}) {
  const t = useTranslations('search');
  const actionError = useActionError();
  const router = useRouter();

  const [query, setQuery] = React.useState('');
  const debounced = useDebouncedValue(query, 200);
  const [results, setResults] = React.useState<GroupedSearchResults>(EMPTY);
  const [loading, setLoading] = React.useState(false);
  const [errorCode, setErrorCode] = React.useState<ActionErrorCode | null>(null);
  /** Active filter pill: null = mixed "All" view; otherwise a single entity type. */
  const [activeType, setActiveType] = React.useState<SearchEntityType | null>(null);
  const seq = React.useRef(0);

  // Reset when the palette closes so it reopens clean.
  React.useEffect(() => {
    if (!open) {
      setQuery('');
      setResults(EMPTY);
      setLoading(false);
      setErrorCode(null);
      setActiveType(null);
    }
  }, [open]);

  // Debounced server search. Re-runs when the active filter changes too. The seq
  // guard drops responses that arrive after a newer request (Server Actions have
  // no AbortController).
  React.useEffect(() => {
    const q = debounced.trim();
    if (q.length < MIN_QUERY_LEN) {
      setResults(EMPTY);
      setLoading(false);
      setErrorCode(null);
      return;
    }
    const mySeq = ++seq.current;
    setLoading(true);
    setErrorCode(null);
    globalSearchAction({ query: q, type: activeType ?? undefined })
      .then((res) => {
        if (mySeq !== seq.current) return;
        setLoading(false);
        if (res.ok) setResults(res.data);
        else {
          setResults(EMPTY);
          setErrorCode(res.code);
        }
      })
      .catch(() => {
        if (mySeq !== seq.current) return;
        setLoading(false);
        setErrorCode('UNEXPECTED');
      });
  }, [debounced, activeType]);

  const select = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };

  const GROUP_LABEL: Record<SearchEntityType, string> = {
    recipe: t('groups.recipes'),
    ingredient: t('groups.ingredients'),
    transaction: t('groups.transactions'),
    invoice: t('groups.invoices'),
    customer: t('groups.customers'),
  };
  const groupHeading = (type: SearchEntityType): string => GROUP_LABEL[type];

  const filters: FilterDef[] = [
    { type: null, label: t('all'), Icon: LayoutGrid },
    { type: 'recipe', label: t('groups.recipes'), Icon: ChefHat },
    { type: 'ingredient', label: t('groups.ingredients'), Icon: Carrot },
    ...(canSeeFinance
      ? [
          {
            type: 'transaction' as const,
            label: t('groups.transactions'),
            Icon: Receipt,
          },
          {
            type: 'invoice' as const,
            label: t('groups.invoices'),
            Icon: FileText,
          },
          {
            type: 'customer' as const,
            label: t('groups.customers'),
            Icon: Building2,
          },
        ]
      : []),
  ];

  const hasQuery = query.trim().length >= MIN_QUERY_LEN;
  const hasResults = results.groups.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle className="sr-only">{t('title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('hint')}</DialogDescription>

        <Command shouldFilter={false} loop>
          {/* ── Panel 1 — search header (accent-bordered, with keyboard hints) ── */}
          <div className="overflow-hidden rounded-2xl border border-accent-500/40 bg-surface shadow-glow">
            <div className="flex items-center gap-3 px-4">
              <Search className="size-5 shrink-0 text-accent-500" aria-hidden />
              <CommandInput
                value={query}
                onValueChange={setQuery}
                placeholder={
                  canSeeFinance ? t('placeholder') : t('placeholderLimited')
                }
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label={t('clear')}
                  className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition-colors hover:bg-accent-500/15 hover:text-accent-600"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
            </div>
            <div className="flex items-center justify-between border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground/70">
              <span className="flex items-center gap-1.5">
                {t('navigate')}
                <kbd className={KBD}>↑</kbd>
                <kbd className={KBD}>↓</kbd>
              </span>
              <span className="flex items-center gap-1.5">
                {t('close')}
                <kbd className={KBD}>esc</kbd>
              </span>
            </div>
          </div>

          {/* ── Panel 2 — filters + results ── */}
          <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_20px_60px_-15px_rgba(0,0,0,0.28),0_4px_16px_-8px_rgba(0,0,0,0.12)] dark:shadow-[0_20px_60px_-15px_rgba(0,0,0,0.7),0_4px_16px_-8px_rgba(0,0,0,0.4)]">
            {hasQuery && (
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
                {filters.map((f) => {
                  const active = activeType === f.type;
                  return (
                    <button
                      key={f.type ?? 'all'}
                      type="button"
                      onClick={() => setActiveType(f.type)}
                      className={cn(
                        'flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                        active
                          ? 'border-accent-500/40 bg-accent-500/10 text-accent-700 dark:text-accent-300'
                          : 'border-border text-muted-foreground hover:bg-surface-2 hover:text-foreground',
                      )}
                    >
                      <f.Icon className="size-3.5" aria-hidden />
                      {f.label}
                    </button>
                  );
                })}
              </div>
            )}

            <CommandList>
              {/* Idle */}
              {!hasQuery && (
                <div className="flex flex-col items-center gap-2 py-12 text-center">
                  <Search className="size-8 text-muted-foreground/25" aria-hidden />
                  <p className="text-sm text-muted-foreground/60">{t('hint')}</p>
                </div>
              )}

              {/* Loading */}
              {hasQuery && loading && (
                <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin text-accent-500" aria-hidden />
                  {t('loading')}
                </div>
              )}

              {/* Error */}
              {hasQuery && !loading && errorCode && (
                <p role="alert" className="py-12 text-center text-sm text-red-500">
                  {actionError(errorCode)}
                </p>
              )}

              {/* Empty */}
              {hasQuery && !loading && !errorCode && !hasResults && (
                <p className="py-12 text-center text-sm text-muted-foreground/60">
                  {t('empty')}
                </p>
              )}

              {/* Results */}
              {hasQuery &&
                !loading &&
                !errorCode &&
                results.groups.map((group) => {
                  const Icon = GROUP_ICON[group.type];
                  return (
                    <CommandGroup
                      key={group.type}
                      heading={
                        <span className="flex items-center gap-2">
                          {groupHeading(group.type)}
                          <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                            {group.results.length}
                          </span>
                        </span>
                      }
                    >
                      {group.results.map((r) => (
                        <CommandItem
                          key={r.id}
                          value={`${r.type}:${r.id}`}
                          onSelect={() => select(r.href)}
                        >
                          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted-foreground transition-colors group-data-[selected=true]:bg-accent-500/15 group-data-[selected=true]:text-accent-600 dark:group-data-[selected=true]:text-accent-400">
                            <Icon className="size-4" />
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate font-medium text-foreground">
                              {r.title}
                            </span>
                            {r.subtitle && (
                              <span className="truncate text-xs text-muted-foreground">
                                {r.subtitle}
                              </span>
                            )}
                          </span>
                          <span className="ml-auto hidden shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground group-data-[selected=true]:flex">
                            {t('selectHint')}
                            <kbd className={KBD}>↵</kbd>
                          </span>
                        </CommandItem>
                      ))}

                      {/* "Show more" — only in the mixed view when the group is capped */}
                      {activeType === null &&
                        group.results.length >= COLLAPSED_PER_ENTITY && (
                          <CommandItem
                            value={`more:${group.type}`}
                            onSelect={() => setActiveType(group.type)}
                            className="justify-center py-1.5 text-xs font-medium text-accent-700 hover:text-accent-600 dark:text-accent-300"
                          >
                            {t('showMore')}
                          </CommandItem>
                        )}
                    </CommandGroup>
                  );
                })}
            </CommandList>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
