import { notFound } from 'next/navigation';
import { canSeeRecipeCosts, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  getKitchenMenu,
  getManagerMenu,
  listMenuRecipeOptions,
} from '@/lib/data/menus';
import { getOrgSettings } from '@/lib/data/org-settings';
import { MenuEditor } from '@/components/app/menus/menu-editor';
import { MenuKitchenView } from '@/components/app/menus/menu-kitchen-view';

/**
 * Menu detail (Sprint 10). Manager → editor with price + live KPIs; kitchen → a
 * read-only, money-free operational view (F4: the kitchen branch loads the money-
 * free loader, so no price/cost reaches the client).
 */
export default async function MenuDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const organizationId = await getOrgId();
  const canManage = canSeeRecipeCosts(await getUserRole());

  if (canManage) {
    const [menu, recipeOptions, settings] = await Promise.all([
      withOrg(organizationId, (tx) => getManagerMenu(tx, organizationId, id)),
      withOrg(organizationId, (tx) => listMenuRecipeOptions(tx, organizationId)),
      getOrgSettings(),
    ]);
    if (!menu) notFound();

    return (
      <MenuEditor
        mode="edit"
        menuId={menu.id}
        initial={{
          name: menu.name,
          sellingPriceCents: menu.sellingPriceCents,
          notes: menu.notes,
          lines: menu.lines.map((l) => ({
            recipeId: l.recipeId,
            recipeName: l.recipeName,
            quantity: l.quantity,
            available: l.available,
            costPerPortionCents: l.costPerPortionCents,
          })),
        }}
        recipeOptions={recipeOptions}
        currency={settings.currency}
      />
    );
  }

  const menu = await withOrg(organizationId, (tx) =>
    getKitchenMenu(tx, organizationId, id),
  );
  if (!menu) notFound();
  return <MenuKitchenView menu={menu} />;
}
