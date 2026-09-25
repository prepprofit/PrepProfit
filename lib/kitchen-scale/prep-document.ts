import type { RecipeWorkspaceDTO } from '@/lib/data/recipe-workspace';
import type { Dimension } from '@/lib/units';

/**
 * Money-free, print-and-calculator shape of ONE recipe for the Kitchen Scale
 * redesign — the ingredient AND sub-recipe lines merged into the chef's saved
 * visual order (the same `display_sort_order` the recipe workspace uses), plus
 * the structured preparation method. Built from `getRecipeWorkspace(...,
 * 'kitchen')`'s result — ALWAYS the literal `'kitchen'` role, even for a
 * manager, so Kitchen Scale is never a financial surface. Typed to accept
 * either DTO shape (like `lib/recipes/recipe-document.ts`'s `buildRecipeDocument`)
 * since it only reads fields present on BOTH — it never touches a money key.
 */

export type KitchenScaleLine = {
  id: string;
  name: string;
  dimension: Dimension;
  /** Canonical amount (g / ml / count) of the SAVED recipe — always unscaled. */
  quantity: number;
  isSubRecipe: boolean;
};

export type KitchenScaleMethodSection = { title: string; steps: string[] };

export type KitchenScaleRecipeDocument = {
  id: string;
  name: string;
  yieldPortions: number;
  /** Canonical grams, or null when the recipe has no batch yield weight set. */
  yieldWeightGrams: number | null;
  /** Usable yield after trim/loss (100 = no loss). */
  yieldPercentage: number;
  lines: KitchenScaleLine[];
  /** Structured prep-method sections with their steps, in saved order. Empty
   *  when the recipe has no structured method (see `legacyNotes`). */
  method: KitchenScaleMethodSection[];
  /** The pre-Recipes-2.0 free-text notes, shown ONLY as a fallback when the
   *  recipe has no structured method steps at all — never alongside them. */
  legacyNotes: string | null;
};

export function buildKitchenScaleDocument(
  dto: RecipeWorkspaceDTO,
): KitchenScaleRecipeDocument {
  const lines: KitchenScaleLine[] = [
    ...dto.ingredientLines.map((l) => ({
      order: l.displaySortOrder,
      id: l.id,
      name: l.ingredient.name,
      dimension: l.ingredient.dimension,
      quantity: l.quantity,
      isSubRecipe: false,
    })),
    ...dto.componentLines.map((l) => ({
      order: l.displaySortOrder,
      id: l.id,
      name: l.componentRecipeName,
      dimension: 'weight' as Dimension,
      quantity: l.quantityGrams,
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
  const method: KitchenScaleMethodSection[] = [
    ...(stepsBySection.has(null)
      ? [{ title: '', steps: stepsBySection.get(null) ?? [] }]
      : []),
    ...dto.methodSections
      .map((s) => ({ title: s.title, steps: stepsBySection.get(s.id) ?? [] }))
      .filter((s) => s.steps.length > 0),
  ];
  const legacyNotes = method.length === 0 ? (dto.recipe.notes?.trim() || null) : null;

  return {
    id: dto.recipe.id,
    name: dto.recipe.name,
    yieldPortions: dto.recipe.yieldPortions,
    yieldWeightGrams: dto.recipe.yieldWeightGrams,
    yieldPercentage: dto.recipe.yieldPercentage,
    lines,
    method,
    legacyNotes,
  };
}
