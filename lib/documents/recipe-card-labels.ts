import type { RecipeCardDocumentLabels } from './types';

/**
 * Build the localized label set for a recipe card from a next-intl translator
 * scoped to the `recipeCardDocument` namespace. Shared by the PDF renderer and the
 * HTML print page so both render identical wording.
 */
export function buildRecipeCardLabels(
  t: (key: string) => string,
): RecipeCardDocumentLabels {
  return {
    title: t('title'),
    yield: t('yield'),
    portions: t('portions'),
    usableYield: t('usableYield'),
    ingredient: t('ingredient'),
    quantity: t('quantity'),
    cost: t('cost'),
    ingredientCost: t('ingredientCost'),
    labor: t('labor'),
    energy: t('energy'),
    packaging: t('packaging'),
    totalCost: t('totalCost'),
    costPerPortion: t('costPerPortion'),
    sellingPrice: t('sellingPrice'),
    margin: t('margin'),
    notes: t('notes'),
    units: {
      weight: t('units.weight'),
      volume: t('units.volume'),
      count: t('units.count'),
    },
  };
}
