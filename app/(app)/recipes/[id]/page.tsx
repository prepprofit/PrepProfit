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
import {
  listComponentPickerRecipes,
  listRecipeComponents,
} from '@/lib/data/recipe-components';
import { resolveRecipeCostTree } from '@/lib/data/recipe-cost-tree';
import { loadRecipeAllergenRollup } from '@/lib/data/allergens';
import { getOrgSettings } from '@/lib/data/org-settings';
import { RecipeEditor } from '@/components/app/recipes/recipe-editor';
import { RecipeAllergenPanel } from '@/components/app/recipes/recipe-allergen-panel';
import { AddToTaskListMenu } from '@/components/app/tasks/add-to-task-list-menu';
import { isRecipesWorkspaceV2Enabled } from '@/lib/data/recipe-workspace';
import { RecipeWorkspacePage } from './workspace-page';

export default async function RecipeEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ editor?: string }>;
}) {
  const { id } = await params;
  const { editor } = await searchParams;
  const organizationId = await getOrgId();

  // Recipes 2.0 (plan Release B): the per-org flag prefers the new workspace;
  // `?editor=legacy` is the rollback escape hatch while both editors coexist.
  const workspaceV2 = await withOrg(organizationId, (tx) =>
    isRecipesWorkspaceV2Enabled(tx, organizationId),
  );
  if (workspaceV2 && editor !== 'legacy') {
    return <RecipeWorkspacePage recipeId={id} organizationId={organizationId} />;
  }

  const [
    data,
    presets,
    componentLines,
    pickerRecipes,
    ingredientRows,
    folders,
    allergenRollup,
    settings,
    role,
  ] = await Promise.all([
    withOrg(organizationId, (tx) =>
      getRecipeWithIngredients(tx, organizationId, id),
    ),
    withOrg(organizationId, (tx) =>
      listRecipePresets(tx, organizationId, id),
    ),
    withOrg(organizationId, (tx) =>
      listRecipeComponents(tx, organizationId, [id]),
    ),
    withOrg(organizationId, (tx) =>
      listComponentPickerRecipes(tx, organizationId, id),
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

  // Sub-recipe components + picker. Manager additionally gets each component
  // recipe's cost per finished gram (batch total ÷ yield weight) from the shared
  // resolver, so line costs and the live batch cost cascade correctly. Kitchen
  // payloads never carry the money key.
  const unitCostByRecipe = new Map<string, number | null>();
  if (canSeeCosts) {
    const costIds = [
      ...new Set([
        ...componentLines.map((c) => c.componentRecipeId),
        ...pickerRecipes.filter((p) => p.selectable).map((p) => p.id),
      ]),
    ];
    const resolutions = await withOrg(organizationId, (tx) =>
      resolveRecipeCostTree(tx, organizationId, costIds),
    );
    for (const costId of costIds) {
      const resolution = resolutions.get(costId);
      const yieldGrams =
        componentLines.find((c) => c.componentRecipeId === costId)
          ?.componentYieldWeightGrams ??
        pickerRecipes.find((p) => p.id === costId)?.yieldWeightGrams ??
        null;
      unitCostByRecipe.set(
        costId,
        resolution?.complete && yieldGrams != null && yieldGrams > 0
          ? resolution.cost.totalCostCents / yieldGrams
          : null,
      );
    }
  }
  const componentProps = componentLines.map((c) => ({
    id: c.id,
    componentRecipeId: c.componentRecipeId,
    name: c.componentName,
    quantityGrams: c.quantityGrams,
    sortOrder: c.sortOrder,
    ...(canSeeCosts
      ? { unitCostCentsPerGram: unitCostByRecipe.get(c.componentRecipeId) ?? null }
      : {}),
  }));
  const pickerProps = pickerRecipes.map((p) => ({
    id: p.id,
    name: p.name,
    yieldWeightGrams: p.yieldWeightGrams,
    selectable: p.selectable,
    disabledReason: p.disabledReason,
    ...(canSeeCosts
      ? { unitCostCentsPerGram: unitCostByRecipe.get(p.id) ?? null }
      : {}),
  }));

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <RecipeEditor
        canSeeCosts={canSeeCosts}
        recipe={view.recipe}
        initialLines={view.lines}
        initialComponents={componentProps}
        componentPicker={pickerProps}
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
