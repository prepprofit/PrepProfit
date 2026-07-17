import { notFound } from 'next/navigation';
import { canSeeRecipeCosts, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getRecipeWorkspace } from '@/lib/data/recipe-workspace';
import { listIngredients } from '@/lib/data/ingredients';
import { listComponentPickerRecipes } from '@/lib/data/recipe-components';
import { resolveRecipeCostTree } from '@/lib/data/recipe-cost-tree';
import { loadRecipeAllergenRollup } from '@/lib/data/allergens';
import { getOrgSettings } from '@/lib/data/org-settings';
import { RecipeAllergenPanel } from '@/components/app/recipes/recipe-allergen-panel';
import {
  RecipeWorkspace,
  type WorkspaceClientData,
} from '@/components/app/recipes/workspace/recipe-workspace';
import type { DraftLine } from '@/components/app/recipes/workspace/recipe-input-list';

const UNIT_LABEL: Record<'weight' | 'volume' | 'count', string> = {
  weight: 'g',
  volume: 'ml',
  count: 'pcs',
};

/**
 * Server side of the Recipes 2.0 workspace (plan §5): ONE DTO load, mapped to
 * the serializable client payload. Role separation happens HERE — the kitchen
 * DTO carries no financial keys, so `cost` ships as null and no price can
 * reach the client.
 */
export async function RecipeWorkspacePage({
  recipeId,
  organizationId,
}: {
  recipeId: string;
  organizationId: string;
}) {
  const role = await getUserRole();
  const workspaceRole = canSeeRecipeCosts(role) ? 'manager' : 'kitchen';

  const [dto, ingredientRows, pickerRecipes, allergenRollup, settings] =
    await Promise.all([
      withOrg(organizationId, (tx) =>
        getRecipeWorkspace(tx, organizationId, recipeId, workspaceRole),
      ),
      withOrg(organizationId, (tx) => listIngredients(tx, organizationId)),
      withOrg(organizationId, (tx) =>
        listComponentPickerRecipes(tx, organizationId, recipeId),
      ),
      withOrg(organizationId, (tx) =>
        loadRecipeAllergenRollup(tx, organizationId, recipeId),
      ),
      getOrgSettings(),
    ]);
  if (!dto) notFound();

  // Merged visual sequence: ingredient + component lines by display order.
  type OrderedLine = DraftLine & { displaySortOrder: number };
  const ingredientLines: OrderedLine[] = dto.ingredientLines.map((l) => ({
    key: l.id,
    kind: 'ingredient' as const,
    id: l.id,
    ingredientId: l.ingredientId,
    name: l.ingredient.name,
    unitLabel: UNIT_LABEL[l.ingredient.dimension],
    quantity: l.quantity,
    note: l.note ?? '',
    sectionRef: l.sectionId,
    displaySortOrder: l.displaySortOrder,
  }));
  const componentLines: OrderedLine[] = dto.componentLines.map((l) => ({
    key: l.id,
    kind: 'component' as const,
    id: l.id,
    componentRecipeId: l.componentRecipeId,
    name: l.componentRecipeName,
    quantityGrams: l.quantityGrams,
    note: l.note ?? '',
    sectionRef: l.sectionId,
    displaySortOrder: l.displaySortOrder,
  }));
  // Strip the sort key after ordering — the client model orders by position.
  const lines: DraftLine[] = [...ingredientLines, ...componentLines]
    .sort((a, b) => a.displaySortOrder - b.displaySortOrder)
    .map(({ displaySortOrder: _order, ...line }) => line as DraftLine);

  // Method view: steps grouped under their section (default section = '').
  const stepsBySection = new Map<string | null, typeof dto.steps>();
  for (const step of dto.steps) {
    const list = stepsBySection.get(step.sectionId) ?? [];
    list.push(step);
    stepsBySection.set(step.sectionId, list);
  }
  const methodSections = [
    ...(stepsBySection.has(null)
      ? [
          {
            id: '__default',
            title: '',
            steps: (stepsBySection.get(null) ?? []).map((s) => ({
              id: s.id,
              instruction: s.instruction,
            })),
          },
        ]
      : []),
    ...dto.methodSections.map((section) => ({
      id: section.id,
      title: section.title,
      steps: (stepsBySection.get(section.id) ?? []).map((s) => ({
        id: s.id,
        instruction: s.instruction,
      })),
    })),
  ];

  // Manager-only cost summary from the shared resolver (kitchen: null).
  let cost: WorkspaceClientData['cost'] = null;
  if (dto.role === 'manager') {
    const resolution = (
      await withOrg(organizationId, (tx) =>
        resolveRecipeCostTree(tx, organizationId, [recipeId]),
      )
    ).get(recipeId);
    cost = resolution?.complete
      ? { complete: true, cost: resolution.cost }
      : { complete: false };
  }

  const data: WorkspaceClientData = {
    recipe: {
      id: dto.recipe.id,
      name: dto.recipe.name,
      subtitle: dto.recipe.subtitle,
      version: dto.recipe.version,
      yieldQuantity: dto.recipe.yieldQuantity,
      yieldUnit: dto.recipe.yieldUnit,
      yieldPortions: dto.recipe.yieldPortions,
      yieldWeightGrams: dto.recipe.yieldWeightGrams,
      notes: dto.recipe.notes,
    },
    sections: dto.ingredientSections.map((s) => ({
      ref: s.id,
      id: s.id,
      title: s.title,
    })),
    lines,
    methodSections,
    methodDraftSections: dto.methodSections.map((s) => ({
      ref: s.id,
      id: s.id,
      title: s.title,
    })),
    methodDraftSteps: dto.steps.map((s) => ({
      key: s.id,
      id: s.id,
      instruction: s.instruction,
      sectionRef: s.sectionId,
    })),
    books: dto.books,
    ingredientOptions: ingredientRows.map((i) => ({ id: i.id, name: i.name })),
    componentOptions: pickerRecipes
      .filter((p) => p.selectable)
      .map((p) => ({ id: p.id, name: p.name })),
    cost,
    currency: settings.currency,
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <RecipeWorkspace data={data} />
      {/* Allergens stay OPERATIONAL and shared with the legacy page. */}
      <RecipeAllergenPanel recipeId={recipeId} initialRollup={allergenRollup} />
    </div>
  );
}
