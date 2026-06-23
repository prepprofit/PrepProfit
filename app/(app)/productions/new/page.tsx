import { canSeeRecipeCosts, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listProductionRecipeOptions } from '@/lib/data/productions';
import { ProductionEditor } from '@/components/app/productions/production-editor';

/**
 * New production (Sprint 11a). Both roles can create a draft. The recipe picker is
 * money-free (id + name only). `canSeeCost` only tweaks the incomplete-banner copy —
 * a new draft has no cost on screen.
 */
export default async function NewProductionPage() {
  const organizationId = await getOrgId();
  const canSeeCost = canSeeRecipeCosts(await getUserRole());

  const recipeOptions = await withOrg(organizationId, (tx) =>
    listProductionRecipeOptions(tx, organizationId),
  );

  return (
    <ProductionEditor
      mode="create"
      initial={{ reference: null, notes: null, plannedFor: null, lines: [] }}
      recipeOptions={recipeOptions}
      canSeeCost={canSeeCost}
    />
  );
}
