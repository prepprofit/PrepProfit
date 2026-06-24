import {
  scaleLineQuantity,
  type RecipeScaleResult,
} from '@/lib/calculations/recipeScale';
import type { KitchenRecipeWithIngredients } from '@/lib/data/recipes';
import type {
  RecipePrepCardData,
  RecipePrepCardLine,
  RecipeScaleMeta,
} from './types';
import { buildSellerIdentity, type SellerSettings } from './seller';

/**
 * Pure mapping from an OPERATIONAL recipe + its lines → the prep-card view-model
 * (Recipe scaling MVP). No I/O. It takes the money-free `KitchenRecipeWithIngredients`
 * shape on purpose: the resulting view-model is money-free BY TYPE, so a prep card can
 * never leak a cost, price, or total — the keys are absent, not hidden. Both roles may
 * render it.
 *
 * Optional `scale`: when a successful scale is passed, line quantities multiply by the
 * factor (rounded once at the canonical 2-decimal boundary) and the scale metadata is
 * stamped for the "Scaled to …" header. `yieldPercentage` is untouched recipe metadata
 * (recipe scaling is NOT production explosion — it never applies yield/loss).
 */
export function buildRecipePrepCardData(
  data: KitchenRecipeWithIngredients,
  settings: SellerSettings,
  /** Clerk organization name, used when `businessName` is blank. */
  orgNameFallback: string | null,
  scale?: RecipeScaleResult | null,
): RecipePrepCardData {
  const { recipe, lines: recipeLines } = data;
  const factor = scale && scale.ok ? scale.factor : 1;
  const scaleMeta: RecipeScaleMeta | null =
    scale && scale.ok
      ? {
          factor: Math.round(scale.factor * 10000) / 10000,
          scaledPortions: Math.round(scale.scaledPortions * 100) / 100,
        }
      : null;

  const lines: RecipePrepCardLine[] = recipeLines.map((l) => ({
    name: l.ingredient.name,
    dimension: l.ingredient.dimension,
    quantity: scaleLineQuantity(l.quantity, factor),
  }));

  return {
    seller: buildSellerIdentity(settings, orgNameFallback),
    recipeName: recipe.name,
    yieldPortions: recipe.yieldPortions,
    yieldPercentage: recipe.yieldPercentage,
    scale: scaleMeta,
    lines,
    notes: recipe.notes,
  };
}

/** Filename stem for a downloaded prep card. */
export function recipePrepCardFilename(recipeName: string): string {
  return `prep-${recipeName}`;
}
