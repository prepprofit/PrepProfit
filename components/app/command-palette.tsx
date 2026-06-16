'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Carrot, ChefHat, Loader2, Receipt } from 'lucide-react';
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

/** Icon per entity group (cosmetic). */
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
 * ⌘K global search palette (Sprint 2.7). Debounced, server-driven (cmdk runs in
 * `shouldFilter={false}` — results arrive ranked from `globalSearchAction`), with
 * a stale-response guard so out-of-order responses can't overwrite fresh ones.
 * Open state is owned by the app shell; RBAC is enforced on the server (a kitchen
 * user simply never receives a transactions group).
 */
export function CommandPalette({
  open,
  onOpenChange,
  canSeeFinance,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Only affects the placeholder copy; the server is the real RBAC gate. */
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

  // Reset when the palette closes so it reopens clean.
  React.useEffect(() => {
    if (!open) {
      setQuery('');
      setResults(EMPTY);
      setLoading(false);
      setErrorCode(null);
    }
  }, [open]);

  // Debounced server search. The seq guard drops responses that arrive after a
  // newer request (Server Actions have no AbortController).
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
      <DialogContent className="overflow-hidden p-0">
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
            {!hasQuery && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t('hint')}
              </p>
            )}

            {hasQuery && loading && (
              <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {t('loading')}
              </p>
            )}

            {hasQuery && !loading && errorCode && (
              <p role="alert" className="py-8 text-center text-sm text-red-600">
                {actionError(errorCode)}
              </p>
            )}

            {hasQuery && !loading && !errorCode && !hasResults && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t('empty')}
              </p>
            )}

            {hasQuery &&
              !loading &&
              !errorCode &&
              results.groups.map((group) => {
                const Icon = GROUP_ICON[group.type];
                return (
                  <CommandGroup
                    key={group.type}
                    heading={groupHeading(group.type)}
                  >
                    {group.results.map((r) => (
                      <CommandItem
                        key={r.id}
                        value={`${r.type}:${r.id}`}
                        onSelect={() => select(r.href)}
                      >
                        <Icon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{r.title}</span>
                          {r.subtitle && (
                            <span className="truncate text-xs text-muted-foreground">
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
        </Command>
      </DialogContent>
    </Dialog>
  );
}
