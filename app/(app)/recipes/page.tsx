import { getTranslations } from 'next-intl/server';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listRecipes, type RecipeFilter } from '@/lib/data/recipes';
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

  const recipes = await withOrg(organizationId, (tx) =>
    listRecipes(tx, organizationId, filter),
  );

  const folderOptions = listing.folders.map((f) => ({ id: f.id, name: f.name }));

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
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
