import type { RecipeWorkspaceDTO } from '@/lib/data/recipe-workspace';
import { roundCanonical } from '@/lib/calculations/recipeScale';
import { unitLabel, type Unit } from '@/lib/units';

/**
 * The money-free, print-and-preview shape of ONE recipe: name, output, the ingredient
 * and sub-recipe lines in the chef's saved order (the same `display_sort_order` the
 * recipe page, editor and kitchen calculator use) and the preparation method. Built
 * from the workspace DTO; it never carries a price or cost — a quick view and a
 * printed recipe show the same content to every role.
 */
export type RecipeDocument = {
  id: string;
  name: string;
  output: {
    yieldPortions: number;
    yieldQuantity: number | null;
    yieldUnit: string | null;
    finishedWeightGrams: number | null;
    yieldPercentage: number;
  };
  lines: { key: string; name: string; amount: number; unit: string; isSubRecipe: boolean }[];
  method: { title: string; steps: string[] }[];
};

const CANONICAL_UNIT = { weight: 'g', volume: 'ml', count: 'pcs' } as const;

export function buildRecipeDocument(dto: RecipeWorkspaceDTO, finishedWeightGrams: number | null): RecipeDocument {
  const lines = [
    ...dto.ingredientLines.map((l) => {
      const entered = l.enteredQuantity != null && l.enteredUnit != null;
      return {
        order: l.displaySortOrder,
        key: l.id,
        name: l.ingredient.name,
        amount: roundCanonical(entered ? (l.enteredQuantity as number) : l.quantity),
        unit: entered ? unitLabel(l.enteredUnit as Unit) || 'pcs' : CANONICAL_UNIT[l.ingredient.dimension],
        isSubRecipe: false,
      };
    }),
    ...dto.componentLines.map((l) => ({
      order: l.displaySortOrder,
      key: l.id,
      name: l.componentRecipeName,
      amount: roundCanonical(l.quantityGrams),
      unit: 'g',
      isSubRecipe: true,
    })),
  ]
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...line }) => line);

  const stepsBySection = new Map<string | null, string[]>();
  for (const step of dto.steps) {
    const text = step.instruction.trim();
    if (text === '') continue;
    const list = stepsBySection.get(step.sectionId) ?? [];
    list.push(text);
    stepsBySection.set(step.sectionId, list);
  }
  const method = [
    ...(stepsBySection.has(null) ? [{ title: '', steps: stepsBySection.get(null) ?? [] }] : []),
    ...dto.methodSections
      .map((s) => ({ title: s.title, steps: stepsBySection.get(s.id) ?? [] }))
      .filter((s) => s.steps.length > 0),
  ];

  return {
    id: dto.recipe.id,
    name: dto.recipe.name,
    output: {
      yieldPortions: dto.recipe.yieldPortions,
      yieldQuantity: dto.recipe.yieldQuantity,
      yieldUnit: dto.recipe.yieldUnit,
      finishedWeightGrams,
      yieldPercentage: dto.recipe.yieldPercentage,
    },
    lines,
    method,
  };
}
