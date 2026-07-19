'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import type { BookWithCount } from '@/lib/data/recipe-books';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useActionError } from '@/lib/i18n/use-action-error';
import {
  createBookAction,
  deleteBookAction,
  renameBookAction,
  reorderBookAction,
} from '@/app/(app)/recipes/book-actions';

/**
 * Recipe Books section of the /recipes left rail (Fase 7, parity with
 * `Recipes/2.png`). Mirrors the FolderRail interaction model: navigation is by
 * `?book=` Links with live ACTIVE-recipe counts; management (create / rename /
 * reorder / delete) calls the book Server Actions and `router.refresh()`s.
 * Books are OPERATIONAL (no money) — both roles manage them. Deleting a book
 * never touches recipes (membership is additive metadata).
 */
export function BookRail({
  books,
  activeBookId,
}: {
  books: BookWithCount[];
  activeBookId: string | null;
}) {
  const t = useTranslations('recipes.books');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();

  const [error, setError] = React.useState<string | null>(null);
  const [newName, setNewName] = React.useState('');
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameText, setRenameText] = React.useState('');
  const [deleteTarget, setDeleteTarget] = React.useState<{
    id: string;
    name: string;
  } | null>(null);
  const [pending, startTransition] = React.useTransition();

  const onCreate = () => {
    const name = newName.trim();
    if (name === '') {
      setError(t('errors.nameRequired'));
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createBookAction({ name });
      if (result.ok) {
        setNewName('');
        router.push(`/recipes?book=${result.data.id}`);
        router.refresh();
      } else {
        setError(actionError(result.code));
      }
    });
  };

  const commitRename = () => {
    if (!renamingId) return;
    const name = renameText.trim();
    if (name === '') {
      setError(t('errors.nameRequired'));
      return;
    }
    const id = renamingId;
    setError(null);
    startTransition(async () => {
      const result = await renameBookAction(id, { name });
      if (result.ok) {
        setRenamingId(null);
        router.refresh();
      } else {
        setError(actionError(result.code));
      }
    });
  };

  const reorder = (id: string, direction: 'up' | 'down') => {
    setError(null);
    startTransition(async () => {
      const result = await reorderBookAction(id, { direction });
      if (result.ok) router.refresh();
      else setError(actionError(result.code));
    });
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setError(null);
    startTransition(async () => {
      const result = await deleteBookAction(id);
      if (result.ok) {
        if (activeBookId === id) router.push('/recipes');
        router.refresh();
      } else {
        setError(actionError(result.code));
      }
      setDeleteTarget(null);
    });
  };

  return (
    <nav
      aria-label={t('title')}
      className="flex flex-col gap-0.5 self-start rounded-xl border border-border bg-surface p-2"
    >
      <p className="px-2.5 pb-1 pt-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t('title')}
      </p>

      {error && (
        <div
          role="alert"
          className="mb-1 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {books.map((book, index) => {
        const active = activeBookId === book.id;
        if (renamingId === book.id) {
          return (
            <div key={book.id} className="flex h-9 items-center gap-1 px-1">
              <Input
                aria-label={t('rename')}
                autoFocus
                className="h-8"
                value={renameText}
                disabled={pending}
                onChange={(e) => setRenameText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setRenamingId(null);
                }}
              />
              <RailIcon
                label={t('renameSave')}
                disabled={pending}
                onClick={commitRename}
              >
                <Check className="size-4" />
              </RailIcon>
              <RailIcon
                label={tCommon('cancel')}
                disabled={pending}
                onClick={() => setRenamingId(null)}
              >
                <X className="size-4" />
              </RailIcon>
            </div>
          );
        }
        return (
          <div
            key={book.id}
            className={cn(
              'group flex h-9 items-center rounded-lg transition-colors',
              active ? 'bg-accent-50 dark:bg-accent-500/15' : 'hover:bg-surface-2',
            )}
          >
            <Link
              href={`/recipes?book=${book.id}`}
              className={cn(
                'flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 text-sm transition-colors',
                active
                  ? 'font-medium text-accent-700 dark:text-accent-300'
                  : 'text-foreground',
              )}
            >
              {book.icon ? (
                <span
                  aria-hidden
                  className="grid size-4 shrink-0 place-items-center text-sm leading-none"
                >
                  {book.icon}
                </span>
              ) : (
                <BookOpen className="size-4 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">{book.name}</span>
            </Link>

            <span className="shrink-0 px-2.5 text-xs tabular-nums text-muted-foreground sm:group-hover:hidden sm:group-focus-within:hidden">
              {book.recipeCount}
            </span>

            <div className="flex shrink-0 items-center gap-0.5 pr-1 sm:hidden sm:group-hover:flex sm:group-focus-within:flex">
              <RailIcon
                label={t('moveUp')}
                disabled={pending || index === 0}
                onClick={() => reorder(book.id, 'up')}
              >
                <ChevronUp className="size-4" />
              </RailIcon>
              <RailIcon
                label={t('moveDown')}
                disabled={pending || index === books.length - 1}
                onClick={() => reorder(book.id, 'down')}
              >
                <ChevronDown className="size-4" />
              </RailIcon>
              <RailIcon
                label={t('rename')}
                disabled={pending}
                onClick={() => {
                  setError(null);
                  setRenamingId(book.id);
                  setRenameText(book.name);
                }}
              >
                <Pencil className="size-4" />
              </RailIcon>
              <RailIcon
                label={t('delete')}
                disabled={pending}
                onClick={() => setDeleteTarget({ id: book.id, name: book.name })}
              >
                <Trash2 className="size-4" />
              </RailIcon>
            </div>
          </div>
        );
      })}

      <div className="mt-2 flex items-center gap-1.5 border-t border-border pt-2">
        <Input
          aria-label={t('create')}
          placeholder={t('newPlaceholder')}
          className="h-9"
          value={newName}
          disabled={pending}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCreate();
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="size-9 shrink-0 px-0"
          aria-label={t('create')}
          disabled={pending}
          onClick={onCreate}
        >
          <Plus className="size-4" />
        </Button>
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('deleteConfirm.title')}
        description={t('deleteConfirm.body', { name: deleteTarget?.name ?? '' })}
        confirmLabel={tCommon('delete')}
        cancelLabel={tCommon('cancel')}
        destructive
        pending={pending}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </nav>
  );
}

/** Compact icon-only button for the per-book hover toolbar. */
function RailIcon({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}
