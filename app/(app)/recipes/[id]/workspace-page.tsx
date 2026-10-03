import { notFound } from 'next/navigation';
import { AddToTaskListMenu } from '@/components/app/tasks/add-to-task-list-menu';
import { RecipeAllergenPanel } from '@/components/app/recipes/recipe-allergen-panel';
import { RecipeWorkspace } from '@/components/app/recipes/workspace/recipe-workspace';
import { loadRecipeWorkspaceData } from './workspace-data';

/**
 * The saved recipe (view): ingredients with scaling, finished weight, method and
 * the supporting sections. Editing happens in the recipe editor
 * (`/recipes/[id]/edit`); kitchen workflows — scale, slideshow, prep tasks — stay
 * here. Role separation happens in the loader: kitchen gets no money keys.
 */
export async function RecipeWorkspacePage({
  recipeId,
  organizationId,
  savedNotice = false,
}: {
  recipeId: string;
  organizationId: string;
  savedNotice?: boolean;
}) {
  const loaded = await loadRecipeWorkspaceData(recipeId, organizationId);
  if (!loaded) notFound();
  const { data, allergenRollup } = loaded;

  return (
    <div className="flex w-full flex-col gap-6">
      {/* Allergens are OPERATIONAL (both roles) and render below the recipe, like
          every supporting section. */}
      <RecipeWorkspace
        data={data}
        savedNotice={savedNotice}
        allergenPanel={
          <RecipeAllergenPanel recipeId={recipeId} initialRollup={allergenRollup} />
        }
        taskMenu={<AddToTaskListMenu kind="prep" sourceId={recipeId} />}
      />
    </div>
  );
}
