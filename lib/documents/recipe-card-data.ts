import { lineCostCents, recipeCost } from '@/lib/calculations/recipeCost';
import { marginPercent } from '@/lib/calculations/margin';
import {
  scaleLineQuantity,
  scaleMoneyCents,
  type RecipeScaleResult,
} from '@/lib/calculations/recipeScale';
import type { RecipeWithIngredients } from '@/lib/data/recipes';
import type { RecipeCardDocumentData, RecipeCardLine, RecipeScaleMeta } from './types';
import { buildSellerIdentity, type SellerSettings } from './seller';

/**
 * Pure mapping from a recipe + its lines → the recipe-card (cost sheet) view-model
 * (Sprint 3.5B). No I/O: the caller loads the data inside `withOrg` and passes it
 * here. Reuses the SAME `lineCostCents` / `recipeCost` / `marginPercent` the recipe
 * editor uses, so the card reconciles with the on-screen cost and margin by
 * construction. Money is integer cents throughout.
 *
 * Optional `scale` (Recipe scaling MVP, MANAGER-ONLY here): when a successful scale
 * is passed, line quantities + line/batch money scale by the factor while the UNIT
 * economics stay invariant — cost per portion, selling price, and margin are
 * UNCHANGED. Batch totals scale from the original totals (not re-summed) to preserve
 * the invariant and avoid cent drift; line cost is taken from the unrounded scaled
 * line quantity. A `null`/absent scale (or an `ok: false` result) renders the base
 * unscaled card.
 */
export function buildRecipeCardData(
  data: RecipeWithIngredients,
  settings: SellerSettings,
  /** Clerk organization name, used when `businessName` is blank. */
  orgNameFallback: string | null,
  scale?: RecipeScaleResult | null,
): RecipeCardDocumentData {
  const { recipe, lines: recipeLines } = data;
  const factor = scale && scale.ok ? scale.factor : 1;
  const scaleMeta: RecipeScaleMeta | null =
    scale && scale.ok
      ? {
          factor: Math.round(scale.factor * 10000) / 10000,
          scaledPortions: Math.round(scale.scaledPortions * 100) / 100,
        }
      : null;

  const lines: RecipeCardLine[] = recipeLines.map((l) => ({
    name: l.ingredient.name,
    dimension: l.ingredient.dimension,
    quantity: scaleLineQuantity(l.quantity, factor),
    costCents: Math.round(
      lineCostCents({
        dimension: l.ingredient.dimension,
        priceCents: l.ingredient.priceCents,
        // Cost from the UNROUNDED scaled quantity (round once, at the end).
        quantity: l.quantity * factor,
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
    scale: scaleMeta,
    lines,
    // Batch figures scale from the originals; unit economics stay invariant.
    ingredientCostCents: scaleMoneyCents(cost.ingredientCostCents, factor),
    laborCostCents: scaleMoneyCents(recipe.laborCostCents, factor),
    energyCostCents: scaleMoneyCents(recipe.energyCostCents, factor),
    packagingCostCents: scaleMoneyCents(recipe.packagingCostCents, factor),
    totalCostCents: scaleMoneyCents(cost.totalCostCents, factor),
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
