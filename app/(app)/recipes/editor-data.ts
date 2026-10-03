import { withOrg } from '@/lib/db';
import { listIngredients } from '@/lib/data/ingredients';
import { listComponentPickerRecipes } from '@/lib/data/recipe-components';
import { listFolders } from '@/lib/data/recipe-folders';
import type { RecipeEditorData } from '@/components/app/recipes/editor/recipe-editor';
import type { WorkspaceClientData } from '@/components/app/recipes/workspace/recipe-workspace';
import type { LineUom } from '@/lib/recipes/editor-model';

/**
 * Server-side payloads for the recipe editor. A NEW recipe gets an empty draft (in
 * grams, filed in the folder it was started from when that folder exists) plus the
 * org's ingredients, usable sub-recipes and folders. Editing maps the saved recipe's
 * workspace payload — the same one the recipe page loads — onto the same shape.
 */

/** Sentinel parent id for the sub-recipe picker before the recipe exists (matches no row). */
const NO_PARENT = '__new_recipe__';

export async function loadNewRecipeEditorData(
  organizationId: string,
  requestedFolderId: string | null,
): Promise<RecipeEditorData> {
  const [ingredientRows, pickerRecipes, folders] = await Promise.all([
    withOrg(organizationId, (tx) => listIngredients(tx, organizationId)),
    withOrg(organizationId, (tx) => listComponentPickerRecipes(tx, organizationId, NO_PARENT)),
    withOrg(organizationId, (tx) => listFolders(tx, organizationId)),
  ]);
  const folderId = requestedFolderId && folders.some((f) => f.id === requestedFolderId) ? requestedFolderId : null;
  return {
    recipe: {
      id: null,
      version: null,
      name: '',
      folderId,
      displayUnit: 'g',
      notes: '',
      yieldPercentage: 100,
      yieldWeightSource: null,
      yieldWeightGrams: null,
      yieldReviewNeeded: false,
      coverMediaId: null,
      coverUrl: null,
    },
    sections: [],
    lines: [],
    methodSections: [],
    steps: [],
    presets: [],
    folders: folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId })),
    ingredientOptions: ingredientRows.map((i) => ({ id: i.id, name: i.name, dimension: i.dimension })),
    componentOptions: pickerRecipes.filter((p) => p.selectable).map((p) => ({ id: p.id, name: p.name })),
    lineUom: {},
  };
}

export function editorDataFromWorkspace(data: WorkspaceClientData): RecipeEditorData {
  const lineUom: Record<string, LineUom> = {};
  for (const item of data.uom) {
    lineUom[item.ingredientId] = {
      anchors: item.equivalency,
      prepActions: item.prepActions.map((p) => ({
        id: p.id,
        name: p.name,
        anchors: { weightGrams: p.weightGrams, volumeMl: p.volumeMl, eachCount: p.eachCount },
      })),
    };
  }
  return {
    recipe: {
      id: data.recipe.id,
      version: data.recipe.version,
      name: data.recipe.name,
      folderId: data.recipe.folderId,
      displayUnit: data.recipe.displayUnit,
      notes: data.recipe.notes ?? '',
      yieldPercentage: data.recipe.yieldPercentage,
      yieldWeightSource: data.recipe.yieldWeightSource,
      yieldWeightGrams: data.recipe.yieldWeightGrams,
      yieldReviewNeeded: data.recipe.yieldReviewNeeded,
      coverMediaId: data.recipe.coverMediaId,
      coverUrl: data.recipe.coverUrl,
    },
    sections: data.sections,
    lines: data.lines,
    methodSections: data.methodDraftSections,
    steps: data.methodDraftSteps,
    presets: data.presets.map((p) => ({ id: p.id, name: p.name, targetWeightGrams: p.targetWeightGrams })),
    folders: data.folders,
    ingredientOptions: data.ingredientOptions,
    componentOptions: data.componentOptions,
    lineUom,
  };
}
