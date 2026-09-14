import { canSeeRecipeCosts, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listDishBuilderOptions, listMenuFolderOptions } from '@/lib/data/menus';
import { getOrgSettings } from '@/lib/data/org-settings';
import { NoAccess } from '@/components/app/no-access';
import { DishBuilder } from '@/components/app/menus/dish-builder';

/**
 * New dish (Dish Builder). MANAGER-ONLY: a dish carries its selling price. Kitchen
 * gets NoAccess here AND is refused by the action. `?folder=` pre-selects a folder.
 */
export default async function NewDishPage({
  searchParams,
}: {
  searchParams: Promise<{ folder?: string }>;
}) {
  if (!canSeeRecipeCosts(await getUserRole())) return <NoAccess />;

  const { folder } = await searchParams;
  const organizationId = await getOrgId();
  const [{ folders, options }, settings] = await Promise.all([
    withOrg(organizationId, async (tx) => ({
      folders: await listMenuFolderOptions(tx, organizationId),
      options: await listDishBuilderOptions(tx, organizationId),
    })),
    getOrgSettings(),
  ]);
  const folderId = folders.some((f) => f.id === folder) ? (folder as string) : null;

  return (
    <DishBuilder
      initial={{
        id: null,
        name: '',
        folderId,
        // New products default to a weight batch in grams; the chef enters the amount.
        output: { quantity: 0, unit: 'g', sizeDescription: null, finishedWeightGrams: null },
        sellingPriceCents: null,
        vatRateBps: null,
        labour: null,
        extras: [],
        notes: null,
        recipeLines: [],
        ingredientLines: [],
      }}
      folders={folders}
      recipeOptions={options.recipes}
      ingredientOptions={options.ingredients}
      currency={settings.currency}
      defaultVatBps={settings.defaultTaxRateBps}
    />
  );
}
