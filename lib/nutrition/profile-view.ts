import {
  ingredientNutritionStatus,
  missingCoreNutrients,
  NUTRIENT_KEYS,
  type IngredientNutritionStatus,
  type NutrientKey,
} from '@/lib/calculations/nutrition';
import type { IngredientNutritionProfile } from '@/lib/db/schema';
import type { ExternalFoodQuality, NutritionSourceType } from '@/lib/external-food/types';

/**
 * Serializable, client-safe view of ONE ingredient's nutrition profile — the
 * single shape the Ingredients Nutrition action and the recipe Nutrition tab
 * both render and edit. Values stay per `basisGrams` exactly as stored (no
 * silent rescaling); `basisUnit` says whether that basis is 100 g or 100 ml
 * (a per-100 ml Open Food Facts product carries the `BASIS_VOLUME` warning and
 * a basis converted to grams through the ingredient's equivalency).
 */
export type IngredientNutritionView = {
  source: NutritionSourceType;
  sourceDescription: string | null;
  brandOwner: string | null;
  barcode: string | null;
  externalId: string | null;
  externalSourceType: string | null;
  qualityStatus: ExternalFoodQuality | null;
  basisGrams: number;
  basisUnit: 'g' | 'ml';
  refreshedAt: string | null;
  updatedAt: string;
  values: Record<NutrientKey, number | null>;
};

export function toNutritionView(profile: IngredientNutritionProfile): IngredientNutritionView {
  const values = {} as Record<NutrientKey, number | null>;
  for (const k of NUTRIENT_KEYS) values[k] = profile[k];
  return {
    source: profile.source,
    sourceDescription: profile.sourceDescription,
    brandOwner: profile.brandOwner,
    barcode: profile.barcode,
    externalId: profile.externalSourceId ?? (profile.fdcId !== null ? String(profile.fdcId) : null),
    externalSourceType: profile.externalSourceType ?? profile.fdcDataType,
    qualityStatus: profile.qualityStatus,
    basisGrams: profile.basisGrams,
    basisUnit: profile.qualityWarnings?.includes('BASIS_VOLUME') ? 'ml' : 'g',
    refreshedAt: profile.refreshedAt ? profile.refreshedAt.toISOString() : null,
    updatedAt: profile.updatedAt.toISOString(),
    values,
  };
}

export function nutritionViewStatus(
  view: IngredientNutritionView | null,
): IngredientNutritionStatus {
  return ingredientNutritionStatus(view ? view.values : null);
}

export function nutritionViewMissingCore(view: IngredientNutritionView): NutrientKey[] {
  return missingCoreNutrients(view.values);
}

/**
 * A profile's values re-expressed per 100 g of ingredient — the manual-entry
 * contract. Exact rescale by the stored gram basis; unknown stays unknown.
 */
export function valuesPer100g(
  values: Record<NutrientKey, number | null>,
  basisGrams: number,
): Record<NutrientKey, number | null> {
  const out = {} as Record<NutrientKey, number | null>;
  const valid = Number.isFinite(basisGrams) && basisGrams > 0;
  for (const k of NUTRIENT_KEYS) {
    const v = values[k];
    out[k] = v == null || !valid ? null : basisGrams === 100 ? v : (v * 100) / basisGrams;
  }
  return out;
}
