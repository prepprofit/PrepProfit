import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { BookOpen } from 'lucide-react';
import type { BookWithCount } from '@/lib/data/recipe-books';
import { cn } from '@/lib/utils';

/**
 * Recipe Books section of the /recipes left rail (Fase 7, parity with
 * `Recipes/2.png`). Server-rendered, navigation-only in Slice 2: each book is a
 * `?book=` Link with its live ACTIVE-recipe count. Books are created by the
 * folder write-through (D2) for now; management UI (create/rename/delete/
 * reorder + bulk assignment) arrives with Slice 4. Rendered only when the org
 * has books, so orgs without them see the rail unchanged.
 */
export async function BookRail({
  books,
  activeBookId,
}: {
  books: BookWithCount[];
  activeBookId: string | null;
}) {
  if (books.length === 0) return null;
  const t = await getTranslations('recipes.books');

  return (
    <nav
      aria-label={t('title')}
      className="flex flex-col gap-0.5 self-start rounded-xl border border-border bg-surface p-2"
    >
      <p className="px-2.5 pb-1 pt-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t('title')}
      </p>
      {books.map((book) => {
        const active = activeBookId === book.id;
        return (
          <Link
            key={book.id}
            href={`/recipes?book=${book.id}`}
            className={cn(
              'flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm transition-colors',
              active
                ? 'bg-accent-50 font-medium text-accent-700 dark:bg-accent-500/15 dark:text-accent-300'
                : 'text-foreground hover:bg-surface-2',
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
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {book.recipeCount}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
