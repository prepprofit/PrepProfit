import { notFound } from 'next/navigation';
import { canSeeRecipeCosts, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  getKitchenDish,
  getManagerDish,
  listDishBuilderOptions,
  listMenuFolderOptions,
} from '@/lib/data/menus';
import { getOrgSettings } from '@/lib/data/org-settings';
import { DishBuilder } from '@/components/app/menus/dish-builder';
import { DishKitchenView } from '@/components/app/menus/dish-kitchen-view';

/**
 * Dish detail. Manager → the Dish Builder (live cost + pricing); kitchen → a
 * read-only, money-free composition + allergens (F4: the kitchen branch loads the
 * money-free loader, so no price/cost reaches the client).
 */
export default async function DishPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const organizationId = await getOrgId();

  if (!canSeeRecipeCosts(await getUserRole())) {
    const dish = await withOrg(organizationId, (tx) => getKitchenDish(tx, organizationId, id));
    if (!dish) notFound();
    return <DishKitchenView dish={dish} />;
  }

  const [data, settings] = await Promise.all([
    withOrg(organizationId, async (tx) => ({
      dish: await getManagerDish(tx, organizationId, id),
      folders: await listMenuFolderOptions(tx, organizationId),
      options: await listDishBuilderOptions(tx, organizationId),
    })),
    getOrgSettings(),
  ]);
  if (!data.dish) notFound();

  return (
    <DishBuilder
      initial={data.dish}
      folders={data.folders}
      recipeOptions={data.options.recipes}
      ingredientOptions={data.options.ingredients}
      currency={settings.currency}
      defaultVatBps={settings.defaultTaxRateBps}
    />
  );
}
