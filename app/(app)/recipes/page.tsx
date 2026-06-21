import Link from 'next/link';
import { Camera, FileSpreadsheet, ShieldAlert } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import {
  canAccessFinancials,
  canSeeRecipeCosts,
  getOrgId,
  getUserRole,
} from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listRecipes, toKitchenRecipe, type RecipeFilter } from '@/lib/data/recipes';
import { listFoldersWithCounts } from '@/lib/data/recipe-folders';
import { RecipeList } from '@/components/app/recipes/recipe-list';
import { FolderRail } from '@/components/app/recipes/folder-rail';

export default async function RecipesPage({
  searchParams,
}: {
  searchParams: Promise<{ folder?: string }>;
}) {
  const t = await getTranslations('recipes');
  const organizationId = await getOrgId();
  const { folder } = await searchParams;

  const listing = await withOrg(organizationId, (tx) =>
    listFoldersWithCounts(tx, organizationId),
  );

  // Resolve the active view from `?folder=`. `none` = uncategorized; a known
  // folder id = that folder; anything else (absent or stale) = all recipes.
  const folderExists =
    folder !== undefined &&
    folder !== 'none' &&
    listing.folders.some((f) => f.id === folder);

  let activeKey: string;
  let filter: RecipeFilter;
  let createFolderId: string | null;
  if (folder === 'none') {
    activeKey = 'none';
    filter = { kind: 'uncategorized' };
    createFolderId = null;
  } else if (folderExists && folder) {
    activeKey = folder;
    filter = { kind: 'folder', folderId: folder };
    createFolderId = folder;
  } else {
    activeKey = 'all';
    filter = { kind: 'all' };
    createFolderId = null;
  }

  const recipeRows = await withOrg(organizationId, (tx) =>
    listRecipes(tx, organizationId, filter),
  );

  // Kitchen never sees recipe money — strip it from the list payload, not just the
  // UI (the cards already show only name + portions, but the row carries the money).
  const role = await getUserRole();
  const recipes = canSeeRecipeCosts(role)
    ? recipeRows
    : recipeRows.map(toKitchenRecipe);

  const folderOptions = listing.folders.map((f) => ({ id: f.id, name: f.name }));
  const canImportPhoto = canAccessFinancials(role);

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
        </div>
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-[20rem_1fr]">
        <FolderRail listing={listing} activeKey={activeKey} />
        <RecipeList
          // Re-mount per view so the grid resets to the freshly filtered list.
          key={activeKey}
          recipes={recipes}
          folders={folderOptions}
          createFolderId={createFolderId}
          activeKey={activeKey}
        />
      </div>
    </div>
  );
}
