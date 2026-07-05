import { getTranslations } from 'next-intl/server';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listKitchenScaleRecipes } from '@/lib/data/recipes';
import { listFoldersWithCounts } from '@/lib/data/recipe-folders';
import { getOrgSettings } from '@/lib/data/org-settings';
import { KitchenScaleRecipeList } from '@/components/app/kitchen-scale/recipe-list';

/**
 * Kitchen Scale picker (Kitchen Scale module). OPERATIONAL + MONEY-FREE for BOTH
 * roles by DTO type — no `NoAccess` gate, no money field ever leaves the server.
 * Read-only: create/edit/move/delete stay on `/recipes`.
 */
export default async function KitchenScalePage() {
  const t = await getTranslations('kitchenScale');
  const organizationId = await getOrgId();

  const [recipes, listing, settings] = await Promise.all([
    withOrg(organizationId, (tx) =>
      listKitchenScaleRecipes(tx, organizationId),
    ),
    withOrg(organizationId, (tx) => listFoldersWithCounts(tx, organizationId)),
    getOrgSettings(),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      <KitchenScaleRecipeList
        recipes={recipes}
        folders={listing.folders.map((f) => ({ id: f.id, name: f.name }))}
        measurementSystem={settings.measurementSystem}
      />
    </div>
  );
}
