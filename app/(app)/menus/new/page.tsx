import { canSeeRecipeCosts, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listMenuRecipeOptions } from '@/lib/data/menus';
import { getOrgSettings } from '@/lib/data/org-settings';
import { NoAccess } from '@/components/app/no-access';
import { MenuEditor } from '@/components/app/menus/menu-editor';

/**
 * New menu (Sprint 10). MANAGER-ONLY: creating a menu sets its selling price (a
 * financial mutation). Kitchen gets NoAccess here AND is refused by the action.
 */
export default async function NewMenuPage() {
  if (!canSeeRecipeCosts(await getUserRole())) return <NoAccess />;

  const organizationId = await getOrgId();
  const [recipeOptions, settings] = await Promise.all([
    withOrg(organizationId, (tx) => listMenuRecipeOptions(tx, organizationId)),
    getOrgSettings(),
  ]);

  return (
    <MenuEditor
      mode="create"
      initial={{ name: '', sellingPriceCents: null, notes: null, lines: [] }}
      recipeOptions={recipeOptions}
      currency={settings.currency}
    />
  );
}
