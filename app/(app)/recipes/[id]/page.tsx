import { notFound } from 'next/navigation';
import { canSeeRecipeCosts, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  getRecipeWithIngredients,
  toKitchenRecipeWithIngredients,
} from '@/lib/data/recipes';
import { listIngredients, toKitchenIngredient } from '@/lib/data/ingredients';
import { listFolders } from '@/lib/data/recipe-folders';
import { listRecipePresets } from '@/lib/data/recipe-presets';
import { loadRecipeAllergenRollup } from '@/lib/data/allergens';
import { getOrgSettings } from '@/lib/data/org-settings';
import { RecipeEditor } from '@/components/app/recipes/recipe-editor';
import { RecipeAllergenPanel } from '@/components/app/recipes/recipe-allergen-panel';
import { AddToTaskListMenu } from '@/components/app/tasks/add-to-task-list-menu';

export default async function RecipeEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const organizationId = await getOrgId();

  const [data, presets, ingredientRows, folders, allergenRollup, settings, role] =
    await Promise.all([
      withOrg(organizationId, (tx) =>
        getRecipeWithIngredients(tx, organizationId, id),
      ),
      withOrg(organizationId, (tx) =>
        listRecipePresets(tx, organizationId, id),
      ),
      withOrg(organizationId, (tx) => listIngredients(tx, organizationId)),
      withOrg(organizationId, (tx) => listFolders(tx, organizationId)),
      withOrg(organizationId, (tx) =>
        loadRecipeAllergenRollup(tx, organizationId, id),
      ),
      getOrgSettings(),
      getUserRole(),
    ]);

  if (!data) notFound();

  // Presets are OPERATIONAL-only — both roles get { id, name, targetWeightGrams,
  // sortOrder }; no cost is loaded from the server (managers derive previews client-side).
  const presetProps = presets.map((p) => ({
    id: p.id,
    name: p.name,
    targetWeightGrams: p.targetWeightGrams,
    sortOrder: p.sortOrder,
  }));

  // Kitchen sees the operational recipe only — BOTH money-bearing sources (the
  // recipe + its lines, and the ingredient picker) are stripped server-side.
  const canSeeCosts = canSeeRecipeCosts(role);
  const view = canSeeCosts ? data : toKitchenRecipeWithIngredients(data);
  const ingredients = canSeeCosts
    ? ingredientRows
    : ingredientRows.map(toKitchenIngredient);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <RecipeEditor
        canSeeCosts={canSeeCosts}
        recipe={view.recipe}
        initialLines={view.lines}
        initialPresets={presetProps}
        ingredients={ingredients}
        folders={folders}
        currency={settings.currency}
        measurementSystem={settings.measurementSystem}
      />
      {/* Allergens are OPERATIONAL — shown to kitchen and managers alike (money-free). */}
      <RecipeAllergenPanel recipeId={id} initialRollup={allergenRollup} />
      {/* Prep-task affordance (Sprint 6 D7) — money-free, both roles; appends a prep
          task anchored to this recipe to a chosen task list. */}
      <div className="flex justify-end">
        <AddToTaskListMenu kind="prep" sourceId={id} />
      </div>
    </div>
  );
}
