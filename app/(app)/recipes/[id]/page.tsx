import { notFound } from 'next/navigation';
import { canSeeRecipeCosts, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  getRecipeWithIngredients,
  toKitchenRecipeWithIngredients,
} from '@/lib/data/recipes';
import { listIngredients, toKitchenIngredient } from '@/lib/data/ingredients';
import { listFolders } from '@/lib/data/recipe-folders';
import { loadRecipeAllergenRollup } from '@/lib/data/allergens';
import { getOrgSettings } from '@/lib/data/org-settings';
import { RecipeEditor } from '@/components/app/recipes/recipe-editor';
import { RecipeAllergenPanel } from '@/components/app/recipes/recipe-allergen-panel';

export default async function RecipeEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const organizationId = await getOrgId();

  const [data, ingredientRows, folders, allergenRollup, settings, role] =
    await Promise.all([
      withOrg(organizationId, (tx) =>
        getRecipeWithIngredients(tx, organizationId, id),
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
        ingredients={ingredients}
        folders={folders}
        currency={settings.currency}
        measurementSystem={settings.measurementSystem}
      />
      {/* Allergens are OPERATIONAL — shown to kitchen and managers alike (money-free). */}
      <RecipeAllergenPanel recipeId={id} initialRollup={allergenRollup} />
    </div>
  );
}
