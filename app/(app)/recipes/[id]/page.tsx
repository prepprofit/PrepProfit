import { getOrgId } from '@/lib/auth';
import { RecipeOpenedTracker } from '@/components/app/recipes/recipe-opened-tracker';
import { RecipeWorkspacePage } from './workspace-page';

/**
 * Recipe page. There is ONE recipe screen — the workspace — for every organisation:
 * the recipe at full width with method, cost, nutrition, allergens and kitchen
 * presets below. Editing opens the recipe editor (`./edit`), the same form used to
 * create a recipe. (The classic editor, with its separate navigation and its
 * labour/energy entry, is retired; legacy values are shown for review instead.)
 */
export default async function RecipePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const [{ id }, { saved }] = await Promise.all([params, searchParams]);
  const organizationId = await getOrgId();
  return (
    <>
      <RecipeOpenedTracker recipeId={id} />
      <RecipeWorkspacePage recipeId={id} organizationId={organizationId} savedNotice={saved === '1'} />
    </>
  );
}
