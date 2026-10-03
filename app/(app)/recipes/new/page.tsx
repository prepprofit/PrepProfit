import { getTranslations } from 'next-intl/server';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { countActiveRecipes } from '@/lib/data/recipes';
import { assertPlanLimit } from '@/lib/entitlements';
import { UpgradeRequired } from '@/components/app/upgrade-required';
import { RecipeEditor } from '@/components/app/recipes/editor/recipe-editor';
import { loadNewRecipeEditorData } from '../editor-data';

/**
 * "Add recipe" opens the editor straight away. Nothing is written until "Save
 * recipe": the recipe, its lines, notes and presets are created in one transaction
 * (`createRecipeFromEditorAction`), so leaving or cancelling creates nothing.
 * `?folder=<id>` preselects the folder the chef started from.
 */
export default async function NewRecipePage({
  searchParams,
}: {
  searchParams: Promise<{ folder?: string; from?: string }>;
}) {
  const { folder, from } = await searchParams;
  const organizationId = await getOrgId();

  // The plan's recipe cap is checked up front so nobody types a whole recipe that
  // can't be saved; the save action re-checks it inside its own transaction.
  const allowed = await withOrg(organizationId, async (tx) => {
    const current = await countActiveRecipes(tx, organizationId);
    return (await assertPlanLimit('recipes', current)).allowed;
  });
  if (!allowed) {
    const t = await getTranslations('recipes.editor');
    return <UpgradeRequired body={t('planLimit')} />;
  }

  const requestedFolder = typeof folder === 'string' && folder.length > 0 && folder.length <= 64 ? folder : null;
  const data = await loadNewRecipeEditorData(organizationId, requestedFolder);
  // Cancel returns to the list the chef started from: that folder, "All recipes"
  // (`from=all`), "Unfiled" (`from=none`), or the recipes home.
  const cancelHref = data.recipe.folderId
    ? `/recipes?folder=${data.recipe.folderId}`
    : from === 'all' || from === 'none'
      ? `/recipes?folder=${from}`
      : '/recipes';

  return <RecipeEditor data={data} cancelHref={cancelHref} />;
}
