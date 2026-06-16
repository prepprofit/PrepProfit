'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Carrot, ChefHat, Loader2, Receipt, Search } from 'lucide-react';
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
import type { ActionErrorCode } from '@/lib/action-result';
import type {
  GroupedSearchResults,
  SearchEntityType,
} from '@/lib/search/types';

const GROUP_ICON: Record<
  SearchEntityType,
  React.ComponentType<{ className?: string }>
> = {
  recipe: ChefHat,
  ingredient: Carrot,
  transaction: Receipt,
};

const EMPTY: GroupedSearchResults = { groups: [] };

/**
 * ⌘K global search palette. Debounced + server-driven (shouldFilter={false}).
 * Stale-response guard prevents out-of-order overwrites. RBAC enforced server-side.
 */
export function CommandPalette({
  open,
  onOpenChange,
  canSeeFinance,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
  const seq = React.useRef(0);

  React.useEffect(() => {
    if (!open) {
      setQuery('');
      setResults(EMPTY);
      setLoading(false);
      setErrorCode(null);
    }
  }, [open]);

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
    globalSearchAction({ query: q })
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
  }, [debounced]);

  const select = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };

  const groupHeading = (type: SearchEntityType): string =>
    type === 'recipe'
      ? t('groups.recipes')
      : type === 'ingredient'
        ? t('groups.ingredients')
        : t('groups.transactions');

  const hasQuery = query.trim().length >= MIN_QUERY_LEN;
  const hasResults = results.groups.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0">
        <DialogTitle className="sr-only">{t('title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('hint')}</DialogDescription>

        <Command shouldFilter={false} loop>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={
              canSeeFinance ? t('placeholder') : t('placeholderLimited')
            }
          />

          <CommandList>
            {/* Idle hint */}
            {!hasQuery && (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <Search className="size-8 text-muted-foreground/30" aria-hidden />
                <p className="text-sm text-muted-foreground/60">{t('hint')}</p>
              </div>
            )}

            {/* Loading */}
            {hasQuery && loading && (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin text-accent-500" aria-hidden />
                {t('loading')}
              </div>
            )}

            {/* Error */}
            {hasQuery && !loading && errorCode && (
              <p role="alert" className="py-10 text-center text-sm text-red-500">
                {actionError(errorCode)}
              </p>
            )}

            {/* Empty */}
            {hasQuery && !loading && !errorCode && !hasResults && (
              <p className="py-10 text-center text-sm text-muted-foreground/60">
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
                  <CommandGroup key={group.type} heading={groupHeading(group.type)}>
                    {group.results.map((r) => (
                      <CommandItem
                        key={r.id}
                        value={`${r.type}:${r.id}`}
                        onSelect={() => select(r.href)}
                      >
                        <Icon className="size-4 shrink-0 text-muted-foreground/60 transition-colors group-data-[selected=true]:text-accent-500" />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium">{r.title}</span>
                          {r.subtitle && (
                            <span className="truncate text-xs text-muted-foreground/60">
                              {r.subtitle}
                            </span>
                          )}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              })}
          </CommandList>

          {/* Keyboard hints footer */}
          <div className="flex items-center justify-end gap-4 border-t border-border px-4 py-2.5">
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground/50">
              <kbd className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] leading-tight">
                ↑↓
              </kbd>
              {t('hint_nav')}
            </span>
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground/50">
              <kbd className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] leading-tight">
                ↵
              </kbd>
              {t('hint_open')}
            </span>
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground/50">
              <kbd className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] leading-tight">
                esc
              </kbd>
              {t('hint_close')}
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
