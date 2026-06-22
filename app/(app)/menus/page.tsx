import { canSeeRecipeCosts, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listKitchenMenus, listManagerMenus } from '@/lib/data/menus';
import { getOrgSettings } from '@/lib/data/org-settings';
import { MenusList, type ListMenu } from '@/components/app/menus/menus-list';

/**
 * Menus / combos list (Sprint 10). BOTH roles see name, component count,
 * availability and allergens. The manager additionally sees price/cost/food-cost/
 * margin and the New/Edit controls. F4: the kitchen branch loads the money-free
 * loader, so no price/cost key ever reaches the client.
 */
export default async function MenusPage() {
  const organizationId = await getOrgId();
  const role = await getUserRole();
  const canManage = canSeeRecipeCosts(role);

  if (canManage) {
    const [rows, settings] = await Promise.all([
      withOrg(organizationId, (tx) => listManagerMenus(tx, organizationId)),
      getOrgSettings(),
    ]);
    const menus: ListMenu[] = rows.map((m) => ({
      id: m.id,
      name: m.name,
      notes: m.notes,
      itemCount: m.itemCount,
      complete: m.complete,
      allergens: m.allergens,
      hasUnreviewedIngredient: m.hasUnreviewedIngredient,
      kpis: {
        sellingPriceCents: m.sellingPriceCents,
        costCents: m.costCents,
        foodCostPercent: m.foodCostPercent,
        marginPercent: m.marginPercent,
        trafficLight: m.trafficLight,
      },
    }));
    return <MenusList menus={menus} canManage currency={settings.currency} />;
  }

  const rows = await withOrg(organizationId, (tx) =>
    listKitchenMenus(tx, organizationId),
  );
  const menus: ListMenu[] = rows.map((m) => ({
    id: m.id,
    name: m.name,
    notes: m.notes,
    itemCount: m.itemCount,
    complete: m.complete,
    allergens: m.allergens,
    hasUnreviewedIngredient: m.hasUnreviewedIngredient,
  }));
  // Kitchen never sees money — currency is unused (no KPI cards render).
  return <MenusList menus={menus} canManage={false} currency="" />;
}
