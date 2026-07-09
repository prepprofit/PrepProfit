import type { Dimension } from '@/lib/units';

export type SuggestedYieldWeightInput = {
  lines: { dimension: Dimension; quantityCanonical: number }[];
  components: { quantityGrams: number }[];
};

export type SuggestedYieldWeight = {
  grams: number | null;
  skippedLines: number;
  includedWeightLines: number;
  includedComponents: number;
};

/**
 * UI-only estimate for the manual "Batch yield weight" field: the sum of
 * direct weight lines (canonical grams) plus finished-weight sub-recipe
 * components. Volume/count lines are skipped (no density/per-piece table).
 * Deliberately does NOT apply `yieldPercentage` — that is the production
 * loss factor, a different physical model than this raw-weight estimate.
 */
export function suggestedYieldWeight(
  input: SuggestedYieldWeightInput,
): SuggestedYieldWeight {
  let grams = 0;
  let skippedLines = 0;
  let includedWeightLines = 0;
  let includedComponents = 0;

  for (const line of input.lines) {
    if (line.dimension !== 'weight') {
      skippedLines++;
    } else if (!Number.isFinite(line.quantityCanonical) || line.quantityCanonical < 0) {
      skippedLines++;
    } else if (line.quantityCanonical > 0) {
      grams += line.quantityCanonical;
      includedWeightLines++;
    }
    // zero weight lines: unfinished placeholders — ignored, not skipped
  }

  for (const component of input.components) {
    // UI-state guard only; persisted component quantities are strictly positive
    if (Number.isFinite(component.quantityGrams) && component.quantityGrams > 0) {
      grams += component.quantityGrams;
      includedComponents++;
    }
  }

  return {
    grams: grams > 0 ? Math.round(grams * 100) / 100 : null,
    skippedLines,
    includedWeightLines,
    includedComponents,
  };
}
