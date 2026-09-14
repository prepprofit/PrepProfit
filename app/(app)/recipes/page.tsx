import Link from 'next/link';
import {
  ArrowLeft,
  Camera,
  FileSpreadsheet,
  Folder,
  Inbox,
  Layers,
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
import { DEFAULT_ORG_SETTINGS, getOrgSettingsRow } from '@/lib/data/org-settings';
import { RecipeList } from '@/components/app/recipes/recipe-list';
import { LibraryTable } from '@/components/app/recipes/library-table';
import { AddRecipeButton } from '@/components/app/recipes/add-recipe-button';
import { RecipeHome } from '@/components/app/recipes/recipe-home';
import { cn } from '@/lib/utils';

/**
 * /recipes — two views on one route, so existing `?folder=` links keep working:
 *
 * - Home (no folder): a large search across every folder, a compact "Add recipe",
 *   and the folders as tiles (plus "Unfiled").
 * - Folder (`?folder=<id>`, `?folder=none` for Unfiled, `?folder=all` for every
 *   recipe): full width — back to
 *   Recipes, the folder name, a compact "Add recipe" filed into this folder, and the
 *   recipe table (or `?view=cards`) with its filters and bulk actions.
 *
 * Every list is in recent-activity order (latest edit or open first).
 */
export default async function RecipesPage({
  searchParams,
}: {
  searchParams: Promise<{ folder?: string; view?: string }>;
}) {
  const t = await getTranslations('recipes');
  const organizationId = await getOrgId();
  const { folder, view } = await searchParams;

  const { listing, libraryRows, settings } = await withOrg(
    organizationId,
    async (tx) => ({
      listing: await listFoldersWithCounts(tx, organizationId),
      libraryRows: await listRecipesForLibrary(tx, organizationId),
      settings:
        (await getOrgSettingsRow(tx, organizationId)) ?? DEFAULT_ORG_SETTINGS,
    }),
  );

  const role = await getUserRole();
  const showMoney = canSeeRecipeCosts(role);
  const canImportPhoto = canAccessFinancials(role);
  const folderOptions = listing.folders.map((f) => ({ id: f.id, name: f.name }));

  const activeFolder =
    folder && folder !== 'none'
      ? (listing.folders.find((f) => f.id === folder) ?? null)
      : null;
  const inUnfiled = folder === 'none';
  const inAll = folder === 'all';

  // Allergen matrix is OPERATIONAL + money-free → visible to kitchen too.
  const secondaryLinks = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <SecondaryLink href="/api/recipes/allergen-matrix/pdf" icon={<ShieldAlert className="size-4" />}>
        {t('allergenMatrix.pdf')}
      </SecondaryLink>
      <SecondaryLink href="/api/recipes/allergen-matrix/xlsx" icon={<FileSpreadsheet className="size-4" />}>
        {t('allergenMatrix.xlsx')}
      </SecondaryLink>
      {canImportPhoto && (
        <SecondaryLink href="/recipes/import/photo" icon={<Camera className="size-4" />}>
          {t('importPhoto.link')}
        </SecondaryLink>
      )}
    </div>
  );

  // ── Home ──────────────────────────────────────────────────────────────────
  if (!activeFolder && !inUnfiled && !inAll) {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
          {secondaryLinks}
        </div>
        <RecipeHome
          listing={listing}
          // Search needs names and folders only — never money.
          recipes={libraryRows.map((r) => ({
            id: r.id,
            name: r.name,
            folderId: r.folderId,
            recentActivityAt: r.recentActivityAt,
          }))}
        />
      </div>
    );
  }

  // ── Folder view ───────────────────────────────────────────────────────────
  const activeKey = activeFolder ? activeFolder.id : inAll ? 'all' : 'none';
  // "All" = every active recipe in the business, unfiled included.
  const visibleRows = inAll
    ? libraryRows
    : libraryRows.filter((r) => (activeFolder ? r.folderId === activeFolder.id : r.folderId === null));
  // Kitchen never sees recipe money — strip it from the payload itself, not
  // just the UI (the `money` key is absent from every kitchen row).
  const rows = showMoney ? visibleRows : visibleRows.map(toKitchenLibraryRow);

  // D1: table is the default; `?view=cards` keeps the legacy grid.
  const isCards = view === 'cards';
  const viewHref = (nextView: 'table' | 'cards') => {
    const params = new URLSearchParams({ folder: activeKey });
    if (nextView === 'cards') params.set('view', 'cards');
    return `/recipes?${params.toString()}`;
  };

  return (
    <div className="flex w-full flex-col gap-5">
      <div className="flex flex-col gap-3">
        <Link
          href="/recipes"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {t('home.back')}
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className={cn(
                'flex size-10 shrink-0 items-center justify-center rounded-xl',
                activeFolder || inAll
                  ? 'bg-accent-50 text-accent-700 dark:bg-accent-500/15 dark:text-accent-300'
                  : 'bg-surface-2 text-muted-foreground',
              )}
            >
              {activeFolder?.icon ? (
                <span aria-hidden className="text-xl leading-none">
                  {activeFolder.icon}
                </span>
              ) : activeFolder ? (
                <Folder className="size-5" aria-hidden />
              ) : inAll ? (
                <Layers className="size-5" aria-hidden />
              ) : (
                <Inbox className="size-5" aria-hidden />
              )}
            </span>
            <div className="flex min-w-0 flex-col">
              <h2 className="truncate font-display text-2xl font-semibold tracking-tight text-foreground">
                {activeFolder ? activeFolder.name : inAll ? t('home.allTitle') : t('home.unfiled')}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t('home.recipeCount', { count: visibleRows.length })}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label={t('library.viewToggle')}
              className="inline-flex items-center overflow-hidden rounded-lg border border-border"
            >
              <ViewToggleLink href={viewHref('table')} active={!isCards} label={t('library.viewTable')}>
                <Table2 className="size-4" />
              </ViewToggleLink>
              <ViewToggleLink href={viewHref('cards')} active={isCards} label={t('library.viewCards')}>
                <LayoutGrid className="size-4" />
              </ViewToggleLink>
            </div>
            <AddRecipeButton folders={folderOptions} defaultFolderId={activeFolder?.id ?? null} />
          </div>
        </div>
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
          activeKey={activeKey}
        />
      ) : (
        <LibraryTable key={activeKey} rows={rows} showMoney={showMoney} currency={settings.currency} />
      )}

      <div className="border-t border-border pt-4">{secondaryLinks}</div>
    </div>
  );
}

function SecondaryLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 text-sm font-medium text-accent-700 transition-colors hover:text-accent-800 dark:text-accent-300"
    >
      {icon}
      {children}
    </Link>
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
        'inline-flex size-10 items-center justify-center transition-colors',
        active
          ? 'bg-accent-50 text-accent-700 dark:bg-accent-500/15 dark:text-accent-300'
          : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
      )}
    >
      {children}
    </Link>
  );
}
