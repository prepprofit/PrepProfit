import { canSeeRecipeCosts, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listMenuFolders } from '@/lib/data/menus';
import { MenuHome } from '@/components/app/menus/menu-home';

/**
 * Menu home (Menu redesign): a search across every dish plus the folder grid.
 * Both roles browse (search results and folder tiles are money-free); only
 * managers create folders.
 */
export default async function MenusPage() {
  const organizationId = await getOrgId();
  const canManage = canSeeRecipeCosts(await getUserRole());
  const { folders, unfiledCount } = await withOrg(organizationId, (tx) =>
    listMenuFolders(tx, organizationId),
  );
  return <MenuHome folders={folders} unfiledCount={unfiledCount} canManage={canManage} />;
}
