import type { AllergenSlug } from '@/lib/allergens/catalog';
import { ALLERGEN_ORDER } from '@/lib/allergens/catalog';
import type { RecipeAllergenSummary } from '@/lib/data/allergens';
import { buildSellerIdentity, type SellerSettings } from './seller';
import { documentFilename } from './format';
import type { AllergenMatrixData, AllergenMatrixRow } from './types';

/**
 * Kitchen allergen matrix view-model (Sprint 9). PURE + money-free: it only ever
 * reads recipe names + the allergen rollups (never costs), so the resulting
 * document can never carry money — the kitchen's replacement for the manager-only
 * cost card. Columns are the allergens actually present across the org's recipes,
 * in catalog order; rows are the active recipes (already name-ordered upstream).
 */
export function buildAllergenMatrixData(
  summaries: RecipeAllergenSummary[],
  settings: SellerSettings,
  orgNameFallback: string | null,
  generatedOn: string,
): AllergenMatrixData {
  // Union of allergens present anywhere (effective presence), catalog-sorted.
  const present = new Set<AllergenSlug>();
  for (const s of summaries) {
    for (const a of s.rollup.allergens) present.add(a.allergen);
  }
  const allergens = [...present].sort((a, b) => ALLERGEN_ORDER[a] - ALLERGEN_ORDER[b]);

  const rows: AllergenMatrixRow[] = summaries.map((s) => {
    const cells: AllergenMatrixRow['cells'] = {};
    for (const a of s.rollup.allergens) cells[a.allergen] = a.effectivePresence;
    return {
      recipeName: s.recipeName,
      cells,
      hasUnreviewedIngredient: s.rollup.hasUnreviewedIngredient,
    };
  });

  return {
    seller: buildSellerIdentity(settings, orgNameFallback),
    allergens,
    rows,
    generatedOn,
  };
}

/** Download filename stem (no extension) for the matrix document. */
export function allergenMatrixFilename(): string {
  return documentFilename('allergen-matrix');
}
