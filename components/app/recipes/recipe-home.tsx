'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Folder,
  FolderPlus,
  Inbox,
  Layers,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
} from 'lucide-react';
import type { FolderListing } from '@/lib/data/recipe-folders';
import { searchLibrary } from '@/lib/recipes/library-order';
import { FOLDER_ICONS } from '@/lib/validation/recipe-folders';
import { useActionError } from '@/lib/i18n/use-action-error';
import {
  createFolderAction,
  deleteFolderAction,
  renameFolderAction,
  reorderFolderAction,
} from '@/app/(app)/recipes/folder-actions';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { AddRecipeButton } from './add-recipe-button';

/** What the home search needs per recipe — operational fields only, never money. */
export type RecipeSearchItem = {
  id: string;
  name: string;
  folderId: string | null;
  recentActivityAt: Date;
};

/** How many recent recipes the home shows (the rest are one click away in "All"). */
const RECENT_LIMIT = 8;

type FolderDialog =
  | { mode: 'create' }
  | { mode: 'rename'; id: string; name: string; icon: string | null };

/**
 * Recipes home: a large search across every folder with a compact "Add recipe"
 * beside it, then the folders as tiles — "All" first, "Unfiled" last — and a short
 * "Recent recipes" list (latest edit or open first) for jumping straight back in.
 * Typing swaps tiles and recents for matching recipes — best match first, recent
 * activity breaking ties — and clearing brings them back. Folder management stays
 * available but quiet: a "New folder" tile and a small menu on each folder tile.
 */
export function RecipeHome({
  listing,
  recipes,
}: {
  listing: FolderListing;
  /** Every active recipe, in recent-activity order. */
  recipes: RecipeSearchItem[];
}) {
  const t = useTranslations('recipes.home');
  const tFolders = useTranslations('recipes.folders');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();

  const [query, setQuery] = React.useState('');
  const results = React.useMemo(() => searchLibrary(recipes, query), [recipes, query]);
  const showResults = query.trim() !== '';
  const folderName = React.useMemo(() => new Map(listing.folders.map((f) => [f.id, f.name])), [listing.folders]);
  const folderOptions = listing.folders.map((f) => ({ id: f.id, name: f.name }));

  const [dialog, setDialog] = React.useState<FolderDialog | null>(null);
  const [dialogName, setDialogName] = React.useState('');
  const [dialogIcon, setDialogIcon] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<{ id: string; name: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  function openDialog(next: FolderDialog) {
    setError(null);
    setDialogName(next.mode === 'rename' ? next.name : '');
    setDialogIcon(next.mode === 'rename' ? next.icon : null);
    setDialog(next);
  }

  function saveFolder() {
    if (!dialog) return;
    const name = dialogName.trim();
    if (name === '') {
      setError(tFolders('errors.nameRequired'));
      return;
    }
    setError(null);
    startTransition(async () => {
      if (dialog.mode === 'create') {
        const result = await createFolderAction({ name, icon: dialogIcon });
        if (!result.ok) return setError(actionError(result.code));
        setDialog(null);
        router.push(`/recipes?folder=${result.data.id}`);
        return;
      }
      const result = await renameFolderAction(dialog.id, { name, icon: dialogIcon });
      if (!result.ok) return setError(actionError(result.code));
      setDialog(null);
      router.refresh();
    });
  }

  function reorder(id: string, direction: 'up' | 'down') {
    setError(null);
    startTransition(async () => {
      const result = await reorderFolderAction(id, { direction });
      if (result.ok) router.refresh();
      else setError(actionError(result.code));
    });
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setError(null);
    startTransition(async () => {
      const result = await deleteFolderAction(id);
      if (result.ok) router.refresh();
      else setError(actionError(result.code));
      setDeleteTarget(null);
    });
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results[0]) router.push(`/recipes/${results[0].id}`);
              if (e.key === 'Escape') setQuery('');
            }}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            className="h-14 rounded-2xl pl-12 text-base shadow-sm"
          />
        </div>
        <AddRecipeButton folders={folderOptions} defaultFolderId={null} className="shrink-0 self-end sm:self-auto" />
      </div>

      {error && !dialog && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/15 dark:text-red-300">
          {error}
        </p>
      )}

      {showResults ? (
        <section aria-live="polite" aria-label={t('resultsLabel')} className="flex flex-col gap-2">
          {results.length === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">{t('noResults', { query: query.trim() })}</p>
          ) : (
            <>
              <p className="px-1 text-xs text-muted-foreground">{t('resultCount', { count: results.length })}</p>
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
                {results.map((recipe) => (
                  <li key={recipe.id}>
                    <Link
                      href={`/recipes/${recipe.id}`}
                      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                    >
                      <BookOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-base font-medium text-foreground">{recipe.name}</span>
                      <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
                        {recipe.folderId ? (folderName.get(recipe.folderId) ?? t('unfiled')) : t('unfiled')}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ) : (
        <>
        <section aria-label={tFolders('title')} className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
          <FolderTile
            href="/recipes?folder=all"
            name={t('all')}
            caption={t('allCaption', { count: listing.totalCount })}
            icon={<Layers className="size-5" aria-hidden />}
          />
          {listing.folders.map((folder, index) => (
            <div key={folder.id} className="relative focus-within:z-30">
              <FolderTile
                href={`/recipes?folder=${folder.id}`}
                name={folder.name}
                caption={t('recipeCount', { count: folder.recipeCount })}
                icon={
                  folder.icon ? (
                    <span aria-hidden className="text-xl leading-none">
                      {folder.icon}
                    </span>
                  ) : (
                    <Folder className="size-5" aria-hidden />
                  )
                }
              />
              <FolderMenu
                label={t('folderActions', { name: folder.name })}
                disabled={pending}
                items={[
                  {
                    label: tFolders('rename'),
                    icon: <Pencil className="size-4" />,
                    onSelect: () => openDialog({ mode: 'rename', id: folder.id, name: folder.name, icon: folder.icon }),
                  },
                  {
                    label: tFolders('moveUp'),
                    icon: <ArrowUp className="size-4" />,
                    disabled: index === 0,
                    onSelect: () => reorder(folder.id, 'up'),
                  },
                  {
                    label: tFolders('moveDown'),
                    icon: <ArrowDown className="size-4" />,
                    disabled: index === listing.folders.length - 1,
                    onSelect: () => reorder(folder.id, 'down'),
                  },
                  {
                    label: tFolders('delete'),
                    icon: <Trash2 className="size-4" />,
                    destructive: true,
                    onSelect: () => setDeleteTarget({ id: folder.id, name: folder.name }),
                  },
                ]}
              />
            </div>
          ))}
          <FolderTile
            href="/recipes?folder=none"
            name={t('unfiled')}
            caption={t('recipeCount', { count: listing.uncategorizedCount })}
            icon={<Inbox className="size-5" aria-hidden />}
            muted
          />
          <button
            type="button"
            onClick={() => openDialog({ mode: 'create' })}
            className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground transition-colors hover:border-accent-300 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <FolderPlus className="size-5" aria-hidden />
            {t('newFolder')}
          </button>
          {listing.totalCount === 0 && (
            <p className="col-span-full px-1 text-sm text-muted-foreground">{t('empty')}</p>
          )}
        </section>

        {recipes.length > 0 && (
          <section aria-labelledby="recent-recipes" className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3 px-1">
              <h2 id="recent-recipes" className="text-sm font-semibold text-foreground">
                {t('recent')}
              </h2>
              <Link href="/recipes?folder=all" className="text-sm text-accent-700 hover:underline dark:text-accent-300">
                {t('viewAll')}
              </Link>
            </div>
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
              {recipes.slice(0, RECENT_LIMIT).map((recipe) => (
                <li key={recipe.id}>
                  <Link
                    href={`/recipes/${recipe.id}`}
                    className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                  >
                    <span className="min-w-0 flex-1 truncate text-base font-medium text-foreground">{recipe.name}</span>
                    <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
                      {recipe.folderId ? (folderName.get(recipe.folderId) ?? t('unfiled')) : t('unfiled')}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
        </>
      )}

      <ConfirmDialog
        open={dialog !== null}
        title={dialog?.mode === 'rename' ? tFolders('rename') : t('newFolder')}
        description={t('folderDialogDescription')}
        confirmLabel={dialog?.mode === 'rename' ? tFolders('renameSave') : tFolders('create')}
        cancelLabel={tCommon('cancel')}
        pending={pending}
        onConfirm={saveFolder}
        onCancel={() => setDialog(null)}
      >
        <div className="flex flex-col gap-3 pt-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="folder-name">{t('folderName')}</Label>
            <Input
              id="folder-name"
              autoFocus
              value={dialogName}
              maxLength={80}
              placeholder={tFolders('newPlaceholder')}
              disabled={pending}
              onChange={(e) => setDialogName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  saveFolder();
                }
              }}
            />
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium text-foreground">{tFolders('icon')}</legend>
            <div className="grid grid-cols-8 gap-1">
              <IconChoice selected={dialogIcon === null} label={tFolders('noIcon')} onSelect={() => setDialogIcon(null)}>
                <Folder className="size-4" />
              </IconChoice>
              {FOLDER_ICONS.map((icon) => (
                <IconChoice key={icon} selected={dialogIcon === icon} label={icon} onSelect={() => setDialogIcon(icon)}>
                  <span className="text-lg leading-none">{icon}</span>
                </IconChoice>
              ))}
            </div>
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {error}
            </p>
          )}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={tFolders('deleteConfirm.title')}
        description={tFolders('deleteConfirm.body', { name: deleteTarget?.name ?? '' })}
        confirmLabel={tCommon('delete')}
        cancelLabel={tCommon('cancel')}
        destructive
        pending={pending}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
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
        'flex min-h-28 flex-col justify-between gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-accent-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        muted && 'bg-surface-2/60 shadow-none',
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
      <span className="flex min-w-0 flex-col pr-6">
        <span className="truncate font-medium text-foreground">{name}</span>
        <span className="text-xs text-muted-foreground">{caption}</span>
      </span>
    </Link>
  );
}

type MenuItem = {
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
};

/** The small "⋯" on a folder tile; closes on outside click, Escape or a choice. */
function FolderMenu({ label, items, disabled }: { label: string; items: MenuItem[]; disabled: boolean }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="absolute bottom-2 right-2">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex size-8 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
      >
        <MoreHorizontal className="size-4" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 flex w-48 flex-col rounded-xl border border-border bg-surface p-1 shadow-lg"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-40',
                item.destructive ? 'text-red-700 dark:text-red-300' : 'text-foreground',
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function IconChoice({
  selected,
  label,
  onSelect,
  children,
}: {
  selected: boolean;
  label: string;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      title={label}
      onClick={onSelect}
      className={cn(
        'inline-flex size-9 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-2',
        selected && 'bg-accent-50 ring-1 ring-accent-300 dark:bg-accent-500/15',
      )}
    >
      {children}
    </button>
  );
}
