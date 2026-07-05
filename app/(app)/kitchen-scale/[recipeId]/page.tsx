import { notFound } from 'next/navigation';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  getRecipeWithIngredients,
  toKitchenRecipeWithIngredients,
} from '@/lib/data/recipes';
import { listRecipePresets } from '@/lib/data/recipe-presets';
import { getOrgSettings } from '@/lib/data/org-settings';
import { ScaleWorkbench } from '@/components/app/kitchen-scale/scale-workbench';

/**
 * Kitchen Scale workbench page. ALWAYS maps through
 * `toKitchenRecipeWithIngredients` — even for managers — because Kitchen Scale is
 * not a financial surface: no money key ever reaches the client from here.
 */
export default async function KitchenScaleRecipePage({
  params,
}: {
  params: Promise<{ recipeId: string }>;
}) {
  const { recipeId } = await params;
  const organizationId = await getOrgId();

  const [data, presets, settings] = await Promise.all([
    withOrg(organizationId, (tx) =>
      getRecipeWithIngredients(tx, organizationId, recipeId),
    ),
    withOrg(organizationId, (tx) =>
      listRecipePresets(tx, organizationId, recipeId),
    ),
    getOrgSettings(),
  ]);

  // Missing, trashed, or cross-org recipes all read as null under the org scope.
  if (!data) notFound();

  const view = toKitchenRecipeWithIngredients(data);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <ScaleWorkbench
        recipeId={view.recipe.id}
        recipeName={view.recipe.name}
        recipe={{
          yieldPortions: view.recipe.yieldPortions,
          yieldWeightGrams: view.recipe.yieldWeightGrams,
        }}
        lines={view.lines.map((l) => ({
          id: l.id,
          ingredientId: l.ingredientId,
          name: l.ingredient.name,
          dimension: l.ingredient.dimension,
          quantity: l.quantity,
        }))}
        presets={presets.map((p) => ({
          id: p.id,
          name: p.name,
          targetWeightGrams: p.targetWeightGrams,
        }))}
        measurementSystem={settings.measurementSystem}
      />
    </div>
  );
}
