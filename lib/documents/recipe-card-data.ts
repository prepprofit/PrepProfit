import { lineCostCents, recipeCost } from '@/lib/calculations/recipeCost';
import { marginPercent } from '@/lib/calculations/margin';
import type { RecipeWithIngredients } from '@/lib/data/recipes';
import type { RecipeCardDocumentData, RecipeCardLine } from './types';
import { buildSellerIdentity, type SellerSettings } from './seller';

/**
 * Pure mapping from a recipe + its lines → the recipe-card (cost sheet) view-model
 * (Sprint 3.5B). No I/O: the caller loads the data inside `withOrg` and passes it
 * here. Reuses the SAME `lineCostCents` / `recipeCost` / `marginPercent` the recipe
 * editor uses, so the card reconciles with the on-screen cost and margin by
 * construction. Money is integer cents throughout.
 */
export function buildRecipeCardData(
  data: RecipeWithIngredients,
  settings: SellerSettings,
  /** Clerk organization name, used when `businessName` is blank. */
  orgNameFallback: string | null,
): RecipeCardDocumentData {
  const { recipe, lines: recipeLines } = data;

  const lines: RecipeCardLine[] = recipeLines.map((l) => ({
    name: l.ingredient.name,
    dimension: l.ingredient.dimension,
    quantity: l.quantity,
    costCents: Math.round(
      lineCostCents({
        dimension: l.ingredient.dimension,
        priceCents: l.ingredient.priceCents,
        quantity: l.quantity,
      }),
    ),
  }));

  const cost = recipeCost({
    yieldPortions: recipe.yieldPortions,
    yieldPercentage: recipe.yieldPercentage,
    laborCostCents: recipe.laborCostCents,
    energyCostCents: recipe.energyCostCents,
    packagingCostCents: recipe.packagingCostCents,
    lines: recipeLines.map((l) => ({
      dimension: l.ingredient.dimension,
      priceCents: l.ingredient.priceCents,
      quantity: l.quantity,
    })),
  });

  const sellingPriceCents = recipe.sellingPriceCents;
  const margin =
    sellingPriceCents != null && sellingPriceCents > 0
      ? marginPercent(cost.costPerPortionCents, sellingPriceCents)
      : null;

  return {
    seller: buildSellerIdentity(settings, orgNameFallback),
    recipeName: recipe.name,
    yieldPortions: recipe.yieldPortions,
    yieldPercentage: recipe.yieldPercentage,
    lines,
    ingredientCostCents: cost.ingredientCostCents,
    laborCostCents: recipe.laborCostCents,
    energyCostCents: recipe.energyCostCents,
    packagingCostCents: recipe.packagingCostCents,
    totalCostCents: cost.totalCostCents,
    costPerPortionCents: cost.costPerPortionCents,
    sellingPriceCents: sellingPriceCents ?? null,
    marginPercent: margin,
    notes: recipe.notes,
    currency: settings.currency,
  };
}

/** Filename stem for a downloaded recipe card: the recipe name (sanitized by the
 *  shared `documentFilename`). */
export function recipeCardFilename(recipeName: string): string {
  return `recipe-${recipeName}`;
}
