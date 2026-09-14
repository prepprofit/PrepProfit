import { notFound } from 'next/navigation';
import { canSeeRecipeCosts, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  DISH_LIST_LIMIT,
  getMenuFolder,
  listKitchenDishes,
  listManagerDishes,
} from '@/lib/data/menus';
import { getOrgSettings } from '@/lib/data/org-settings';
import { DISH_SORTS, type DishSort } from '@/lib/validation/menus';
import { MenuFolderView } from '@/components/app/menus/menu-folder-view';

/**
 * One folder's dishes (`/menus/folders/unfiled` = dishes without a folder). The
 * manager branch computes cost/margin; the kitchen branch uses the money-free loader.
 */
export default async function MenuFolderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ sort?: string }>;
}) {
  const [{ id }, { sort: sortParam }] = await Promise.all([params, searchParams]);
  const sort: DishSort = DISH_SORTS.includes(sortParam as DishSort) ? (sortParam as DishSort) : 'modified';
  const organizationId = await getOrgId();
  const canManage = canSeeRecipeCosts(await getUserRole());

  const unfiled = id === 'unfiled';
  const folder = unfiled
    ? null
    : await withOrg(organizationId, (tx) => getMenuFolder(tx, organizationId, id));
  if (!unfiled && !folder) notFound();
  const folderId = folder?.id ?? null;
  const folderProp = folder ? { id: folder.id, name: folder.name } : null;

  if (canManage) {
    const [dishes, settings] = await Promise.all([
      withOrg(organizationId, (tx) => listManagerDishes(tx, organizationId, folderId, sort)),
      getOrgSettings(),
    ]);
    return (
      <MenuFolderView
        canManage
        folder={folderProp}
        sort={sort}
        dishes={dishes}
        currency={settings.currency}
        truncated={dishes.length >= DISH_LIST_LIMIT}
      />
    );
  }

  const dishes = await withOrg(organizationId, (tx) =>
    listKitchenDishes(tx, organizationId, folderId, sort),
  );
  return (
    <MenuFolderView
      canManage={false}
      folder={folderProp}
      sort={sort}
      dishes={dishes}
      truncated={dishes.length >= DISH_LIST_LIMIT}
    />
  );
}
