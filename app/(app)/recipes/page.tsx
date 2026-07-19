import Link from 'next/link';
import {
  Camera,
  FileSpreadsheet,
  LayoutGrid,
  ShieldAlert,
  Table2,
} from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import {
  canAccessFinancials,
  canSeeRecipeCosts,
  getOrgId,
  getUserRole,
} from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  listRecipesForLibrary,
  toKitchenLibraryRow,
} from '@/lib/data/recipe-library';
import { listFoldersWithCounts } from '@/lib/data/recipe-folders';
import { listBooksWithCounts } from '@/lib/data/recipe-books';
import { DEFAULT_ORG_SETTINGS, getOrgSettingsRow } from '@/lib/data/org-settings';
import { RecipeList } from '@/components/app/recipes/recipe-list';
import { FolderRail } from '@/components/app/recipes/folder-rail';
import { BookRail } from '@/components/app/recipes/book-rail';
import { LibraryTable } from '@/components/app/recipes/library-table';
import { cn } from '@/lib/utils';

export default async function RecipesPage({
  searchParams,
}: {
  searchParams: Promise<{ folder?: string; book?: string; view?: string }>;
}) {
  const t = await getTranslations('recipes');
  const organizationId = await getOrgId();
  const { folder, book, view } = await searchParams;

  const { listing, books, libraryRows, settings } = await withOrg(
    organizationId,
    async (tx) => ({
      listing: await listFoldersWithCounts(tx, organizationId),
      books: await listBooksWithCounts(tx, organizationId),
      libraryRows: await listRecipesForLibrary(tx, organizationId),
      settings:
        (await getOrgSettingsRow(tx, organizationId)) ?? DEFAULT_ORG_SETTINGS,
    }),
  );

  // Resolve the active view. A known `?book=` wins over `?folder=`; `none` =
  // uncategorized; a known folder id = that folder; anything else = all.
  const activeBookId =
    book !== undefined && books.some((b) => b.id === book) ? book : null;
  const folderExists =
    folder !== undefined &&
    folder !== 'none' &&
    listing.folders.some((f) => f.id === folder);

  let activeKey: string;
  let createFolderId: string | null = null;
  let visibleRows = libraryRows;
  if (activeBookId) {
    activeKey = `book:${activeBookId}`;
    visibleRows = libraryRows.filter((r) => r.bookIds.includes(activeBookId));
  } else if (folder === 'none') {
    activeKey = 'none';
    visibleRows = libraryRows.filter((r) => r.folderId === null);
  } else if (folderExists && folder) {
    activeKey = folder;
    createFolderId = folder;
    visibleRows = libraryRows.filter((r) => r.folderId === folder);
  } else {
    activeKey = 'all';
  }

  // Kitchen never sees recipe money — strip it from the payload itself, not
  // just the UI (the `money` key is absent from every kitchen row).
  const role = await getUserRole();
  const showMoney = canSeeRecipeCosts(role);
  const rows = showMoney ? visibleRows : visibleRows.map(toKitchenLibraryRow);

  const folderOptions = listing.folders.map((f) => ({ id: f.id, name: f.name }));
  const bookOptions = books.map((b) => ({ id: b.id, name: b.name }));
  const canImportPhoto = canAccessFinancials(role);

  // D1: table is the default; `?view=cards` keeps the legacy grid. The toggle
  // links preserve the active folder/book filter.
  const isCards = view === 'cards';
  const viewHref = (nextView: 'table' | 'cards') => {
    const params = new URLSearchParams();
    if (activeBookId) params.set('book', activeBookId);
    else if (folder) params.set('folder', folder);
    if (nextView === 'cards') params.set('view', 'cards');
    const qs = params.toString();
    return qs ? `/recipes?${qs}` : '/recipes';
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        <div className="flex flex-wrap items-center gap-4">
          {/* Allergen matrix is OPERATIONAL + money-free → visible to kitchen too. */}
          <Link
            href="/api/recipes/allergen-matrix/pdf"
            className="inline-flex items-center gap-2 text-sm font-medium text-accent-700 transition-colors hover:text-accent-800 dark:text-accent-300"
          >
            <ShieldAlert className="size-4" />
            {t('allergenMatrix.pdf')}
          </Link>
          <Link
            href="/api/recipes/allergen-matrix/xlsx"
            className="inline-flex items-center gap-2 text-sm font-medium text-accent-700 transition-colors hover:text-accent-800 dark:text-accent-300"
          >
            <FileSpreadsheet className="size-4" />
            {t('allergenMatrix.xlsx')}
          </Link>
          {canImportPhoto && (
            <Link
              href="/recipes/import/photo"
              className="inline-flex items-center gap-2 text-sm font-medium text-accent-700 transition-colors hover:text-accent-800 dark:text-accent-300"
            >
              <Camera className="size-4" />
              {t('importPhoto.link')}
            </Link>
          )}
          <div
            role="group"
            aria-label={t('library.viewToggle')}
            className="inline-flex items-center overflow-hidden rounded-lg border border-border"
          >
            <ViewToggleLink
              href={viewHref('table')}
              active={!isCards}
              label={t('library.viewTable')}
            >
              <Table2 className="size-4" />
            </ViewToggleLink>
            <ViewToggleLink
              href={viewHref('cards')}
              active={isCards}
              label={t('library.viewCards')}
            >
              <LayoutGrid className="size-4" />
            </ViewToggleLink>
          </div>
        </div>
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-[20rem_1fr]">
        <div className="flex flex-col gap-5">
          <FolderRail
            listing={listing}
            activeKey={activeBookId ? 'book' : activeKey}
          />
          <BookRail books={books} activeBookId={activeBookId} />
        </div>
        {isCards ? (
          <RecipeList
            // Re-mount per view so the grid resets to the freshly filtered list.
            key={activeKey}
            recipes={rows.map((r) => ({
              id: r.id,
              name: r.name,
              yieldPortions: r.yieldPortions,
              folderId: r.folderId,
            }))}
            folders={folderOptions}
            createFolderId={createFolderId}
            activeKey={activeBookId ? 'all' : activeKey}
          />
        ) : (
          <LibraryTable
            key={activeKey}
            rows={rows}
            books={bookOptions}
            showMoney={showMoney}
            currency={settings.currency}
          />
        )}
      </div>
    </div>
  );
}

function ViewToggleLink({
  href,
  active,
  label,
  children,
}: {
  href: string;
  active: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'inline-flex size-9 items-center justify-center transition-colors',
        active
          ? 'bg-accent-50 text-accent-700 dark:bg-accent-500/15 dark:text-accent-300'
          : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
      )}
    >
      {children}
    </Link>
  );
}
