'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Folder, FolderPlus, Inbox, Search, UtensilsCrossed } from 'lucide-react';
import type { DishSearchResult, MenuFolderSummary } from '@/lib/data/menus';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { useActionError } from '@/lib/i18n/use-action-error';
import { createMenuFolderAction, searchDishesAction } from '@/app/(app)/menus/actions';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Menu home (Menu redesign) — deliberately minimal, file-manager style: one big
 * search across EVERY dish, a grid of folders, and a New folder tile. Typing
 * replaces the grid with results; clearing brings the folders back.
 */
export function MenuHome({
  folders,
  unfiledCount,
  canManage,
}: {
  folders: MenuFolderSummary[];
  unfiledCount: number;
  canManage: boolean;
}) {
  const t = useTranslations('menus.home');
  const tFolder = useTranslations('menus.folder');
  const actionError = useActionError();
  const router = useRouter();

  const [query, setQuery] = React.useState('');
  const debounced = useDebouncedValue(query.trim(), 200);
  const [results, setResults] = React.useState<DishSearchResult[] | null>(null);
  const [searching, setSearching] = React.useState(false);

  React.useEffect(() => {
    if (debounced === '') {
      setResults(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    void searchDishesAction({ query: debounced }).then((result) => {
      if (cancelled) return;
      setSearching(false);
      setResults(result.ok ? result.data : []);
    });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  const [creating, setCreating] = React.useState(false);
  const [folderName, setFolderName] = React.useState('');
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  function createFolder() {
    const name = folderName.trim();
    if (!name) return;
    setCreateError(null);
    startTransition(async () => {
      const result = await createMenuFolderAction({ name });
      if (!result.ok) {
        setCreateError(actionError(result.code));
        return;
      }
      setCreating(false);
      setFolderName('');
      router.push(`/menus/folders/${result.data.id}`);
    });
  }

  const showResults = query.trim() !== '';

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && results && results[0]) router.push(`/menus/${results[0].id}`);
            if (e.key === 'Escape') setQuery('');
          }}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchPlaceholder')}
          autoFocus
          className="h-14 rounded-2xl pl-12 text-base shadow-sm"
        />
      </div>

      {showResults ? (
        <section aria-live="polite" className="flex flex-col gap-2">
          {results === null || (searching && results.length === 0) ? (
            <p className="px-1 text-sm text-muted-foreground">{t('searching')}</p>
          ) : results.length === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">{t('noResults', { query: query.trim() })}</p>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
              {results.map((dish) => (
                <li key={dish.id}>
                  <Link
                    href={`/menus/${dish.id}`}
                    className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                  >
                    <UtensilsCrossed className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">{dish.name}</span>
                    <span className="shrink-0 truncate text-xs text-muted-foreground">
                      {dish.folderName ?? tFolder('unfiled')}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <section
          aria-label={t('foldersLabel')}
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
        >
          {folders.map((folder) => (
            <FolderTile
              key={folder.id}
              href={`/menus/folders/${folder.id}`}
              name={folder.name}
              caption={t('dishCount', { count: folder.dishCount })}
              icon={<Folder className="size-6" aria-hidden />}
            />
          ))}
          {unfiledCount > 0 && (
            <FolderTile
              href="/menus/folders/unfiled"
              name={tFolder('unfiled')}
              caption={t('dishCount', { count: unfiledCount })}
              icon={<Inbox className="size-6" aria-hidden />}
              muted
            />
          )}
          {canManage && (
            <button
              type="button"
              onClick={() => {
                setCreateError(null);
                setCreating(true);
              }}
              className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border p-4 text-sm font-medium text-muted-foreground transition-colors hover:border-accent-300 hover:text-accent-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:text-accent-300"
            >
              <FolderPlus className="size-6" aria-hidden />
              {t('newFolder')}
            </button>
          )}
          {folders.length === 0 && unfiledCount === 0 && (
            <p className="col-span-full text-sm text-muted-foreground">
              {canManage ? t('emptyManager') : t('emptyKitchen')}
            </p>
          )}
        </section>
      )}

      <ConfirmDialog
        open={creating}
        title={t('newFolder')}
        description={t('newFolderDescription')}
        confirmLabel={t('create')}
        cancelLabel={t('cancel')}
        pending={pending}
        onConfirm={createFolder}
        onCancel={() => setCreating(false)}
      >
        <div className="flex flex-col gap-1.5">
          <Input
            value={folderName}
            maxLength={80}
            autoFocus
            placeholder={t('folderNamePlaceholder')}
            aria-label={t('folderName')}
            onChange={(e) => setFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                createFolder();
              }
            }}
          />
          {createError && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {createError}
            </p>
          )}
        </div>
      </ConfirmDialog>
    </div>
  );
}

function FolderTile({
  href,
  name,
  caption,
  icon,
  muted = false,
}: {
  href: string;
  name: string;
  caption: string;
  icon: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'group flex min-h-28 flex-col justify-between gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-accent-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        muted && 'bg-surface-2/60',
      )}
    >
      <span
        className={cn(
          'flex size-10 items-center justify-center rounded-xl',
          muted
            ? 'bg-surface-2 text-muted-foreground'
            : 'bg-accent-50 text-accent-700 dark:bg-accent-500/15 dark:text-accent-300',
        )}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-foreground">{name}</span>
        <span className="text-xs text-muted-foreground">{caption}</span>
      </span>
    </Link>
  );
}
