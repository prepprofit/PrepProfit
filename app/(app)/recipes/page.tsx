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
import { DEFAULT_ORG_SETTINGS, getOrgSettingsRow } from '@/lib/data/org-settings';
import { recipesInFolderScope, type FolderScope } from '@/lib/folders/recipe-scope';
import { RecipeHome } from '@/components/app/recipes/recipe-home';
import { RecipeFolderView } from '@/components/app/recipes/recipe-folder-view';
import { cn } from '@/lib/utils';

/**
 * /recipes — two views on one route, so existing `?folder=` links keep working:
 *
 * - Home (no folder): a large search across every folder, a compact "Add recipe",
 *   and the top-level folders as compact shortcuts (plus "All" and "Unfiled").
 * - Folder (`?folder=<id>`, `?folder=none` for Unfiled, `?folder=all` for every
 *   recipe): breadcrumb, folder name + inclusive count + "Add recipe", a large
 *   search, the immediate subfolder shortcuts, then the recipe list.
 *
 * Opening a folder is RECURSIVE: the list holds that folder's recipes AND every
 * descendant folder's, each exactly once (lib/folders/recipe-scope.ts). Nothing
 * is re-filed to achieve it — `folder_id` is untouched read-side aggregation.
 *
 * Every list is in recent-activity order (latest edit or open first).
 */
export default async function RecipesPage({
  searchParams,
}: {
  searchParams: Promise<{ folder?: string; view?: string; q?: string }>;
}) {
  const t = await getTranslations('recipes');
  const organizationId = await getOrgId();
  const { folder, view, q } = await searchParams;

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

  const activeFolder =
    folder && folder !== 'none' && folder !== 'all'
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
  // A folder shows its OWN recipes plus every subfolder's, at any depth; "All" is
  // every active recipe in the business, unfiled included.
  const scope: FolderScope = activeFolder
    ? { kind: 'folder', folderId: activeFolder.id }
    : inAll
      ? { kind: 'all' }
      : { kind: 'unfiled' };
  const visibleRows = recipesInFolderScope(listing.folders, libraryRows, scope);
  // Kitchen never sees recipe money — strip it from the payload itself, not
  // just the UI (the `money` key is absent from every kitchen row).
  const rows = showMoney ? visibleRows : visibleRows.map(toKitchenLibraryRow);

  // D1: table is the default; `?view=cards` keeps the legacy grid.
  const isCards = view === 'cards';
  const viewHref = (nextView: 'table' | 'cards') => {
    const params = new URLSearchParams({ folder: activeKey });
    if (nextView === 'cards') params.set('view', 'cards');
    if (q) params.set('q', q);
    return `/recipes?${params.toString()}`;
  };

  return (
    <RecipeFolderView
      listing={listing}
      activeKey={activeKey}
      folderId={activeFolder?.id ?? null}
      rows={rows}
      showMoney={showMoney}
      currency={settings.currency}
      isCards={isCards}
      initialQuery={q ?? ''}
      secondaryLinks={secondaryLinks}
      viewToggle={
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
      }
    />
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
