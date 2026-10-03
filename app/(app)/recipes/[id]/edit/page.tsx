import { notFound } from 'next/navigation';
import { getOrgId } from '@/lib/auth';
import { RecipeEditor } from '@/components/app/recipes/editor/recipe-editor';
import { RecipeAllergenPanel } from '@/components/app/recipes/recipe-allergen-panel';
import { RecipeCostSummary } from '@/components/app/recipes/workspace/recipe-cost-summary';
import { RecipeNutritionTab } from '@/components/app/recipes/workspace/recipe-nutrition-tab';
import { editorDataFromWorkspace } from '../../editor-data';
import { loadRecipeWorkspaceData } from '../workspace-data';

/**
 * Edit a saved recipe in the same editor used to create one, with everything it
 * already has filled in. Cost (managers only — the loader ships no money to kitchen)
 * and nutrition/allergens of the SAVED recipe sit collapsed at the bottom.
 * `?adjust=finished-weight` opens the finished-weight controls.
 */
export default async function EditRecipePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ adjust?: string }>;
}) {
  const [{ id }, { adjust }] = await Promise.all([params, searchParams]);
  const organizationId = await getOrgId();
  const loaded = await loadRecipeWorkspaceData(id, organizationId);
  if (!loaded) notFound();
  const { data, allergenRollup } = loaded;

  return (
    <RecipeEditor
      data={editorDataFromWorkspace(data)}
      cancelHref={`/recipes/${id}`}
      initialFinishedWeightOpen={adjust === 'finished-weight'}
      details={{
        cost: data.cost ? <RecipeCostSummary recipeId={id} cost={data.cost} currency={data.currency} /> : undefined,
        nutrition: (
          <>
            <RecipeNutritionTab recipeId={id} data={data.nutrition} />
            <RecipeAllergenPanel recipeId={id} initialRollup={allergenRollup} />
          </>
        ),
      }}
    />
  );
}
