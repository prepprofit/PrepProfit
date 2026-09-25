import {
  deriveScale,
  scaleLineQuantity,
  sumPresetBasketGrams,
  type RecipeScaleResult,
} from '@/lib/calculations/recipeScale';
import {
  formatFactorParam,
  formatPresetSelectionParam,
} from '@/lib/validation/kitchen-scale-print';
import type { KitchenScaleLine } from './prep-document';

/**
 * Pure Kitchen Scale calculator model — no React, no I/O, testable in the node
 * Vitest environment. The component owns input text/focus/layout/panel-open
 * state; this module owns the deterministic scale result and the print/PDF
 * query it drives. All arithmetic delegates to lib/calculations/recipeScale;
 * nothing is reimplemented here.
 *
 * The three calculation methods (target weight, ingredient amount, combined
 * kitchen presets) are represented as ONE discriminated `CalculationBasis`, so
 * only one method can ever be "active" at a time — applying one always clears
 * the others, matching the product rule that the screen never claims to make
 * an outdated combination of methods at once.
 */

/** The operational recipe facts the calculator scales from (money-free). */
export type WorkbenchRecipe = {
  yieldPortions: number;
  /** Canonical batch yield weight (grams); null = weight scaling unavailable. */
  yieldWeightGrams: number | null;
};

export type WorkbenchLine = KitchenScaleLine;

/** A kitchen preset the calculator can scale to (operational, no cost). */
export type WorkbenchPreset = {
  id: string;
  name: string;
  /** Canonical target finished weight (grams). */
  targetWeightGrams: number;
};

/** One preset counted into a combined-presets calculation. */
export type PresetSelection = { presetId: string; name: string; quantity: number };

/** Which of the three methods is currently driving the calculator. */
export type CalculationBasis =
  | { kind: 'original' }
  | { kind: 'weight'; targetGrams: number }
  | { kind: 'line'; lineId: string; lineName: string; targetCanonical: number }
  | {
      kind: 'preset';
      selections: PresetSelection[];
      extraGrams: number;
      totalGrams: number;
    };

/** Combine preset quantities (+ an optional loose extra weight) into ONE
 *  canonical target weight (grams) — presets B/C's "combined total". */
export function combinedPresetTargetGrams(
  selections: readonly { targetWeightGrams: number; quantity: number }[],
  extraGrams = 0,
): number {
  return sumPresetBasketGrams(selections, extraGrams);
}

/** Derive the scale result for whichever basis is currently applied. */
export function scaleForBasis(
  recipe: WorkbenchRecipe,
  lines: readonly WorkbenchLine[],
  basis: CalculationBasis,
): RecipeScaleResult {
  if (basis.kind === 'original') {
    return deriveScale(recipe.yieldPortions, { kind: 'factor', factor: 1 });
  }
  if (basis.kind === 'weight') {
    return deriveScale(
      recipe.yieldPortions,
      {
        kind: 'yieldWeight',
        baseWeightGrams: recipe.yieldWeightGrams ?? 0,
        targetWeightGrams: basis.targetGrams,
      },
      lines.map((l) => l.quantity),
    );
  }
  if (basis.kind === 'line') {
    const anchor = lines.find((l) => l.id === basis.lineId);
    if (!anchor) return { ok: false, reason: 'invalid_anchor' };
    return deriveScale(
      recipe.yieldPortions,
      { kind: 'anchor', anchorLineQuantity: anchor.quantity, targetCanonical: basis.targetCanonical },
      lines.map((l) => l.quantity),
    );
  }
  return deriveScale(
    recipe.yieldPortions,
    {
      kind: 'yieldWeight',
      baseWeightGrams: recipe.yieldWeightGrams ?? 0,
      targetWeightGrams: basis.totalGrams,
    },
    lines.map((l) => l.quantity),
  );
}

/** Every line multiplied by `factor`, rounded once at the canonical boundary. */
export function scaledLines(
  lines: readonly WorkbenchLine[],
  factor: number,
): WorkbenchLine[] {
  return lines.map((l) => ({ ...l, quantity: scaleLineQuantity(l.quantity, factor) }));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * The print/PDF `?factor=...&basis=...` query for the CURRENT basis + its
 * scale result — the SAME string builds both the print link and the download
 * link, so they can never drift (print/download always agree). `''` (no
 * query) means the original, unscaled recipe. `null` means the current basis
 * cannot be exported (an invalid/overflowing scale) — callers disable the
 * print/download actions in that case rather than linking to a stale result.
 */
export function prepCardQueryFor(
  basis: CalculationBasis,
  scale: RecipeScaleResult,
): string | null {
  if (basis.kind === 'original') return '';
  if (!scale.ok) return null;

  const params = new URLSearchParams();
  params.set('factor', formatFactorParam(scale.factor));
  if (basis.kind === 'weight') {
    params.set('basis', 'weight');
    params.set('grams', String(round4(basis.targetGrams)));
  } else if (basis.kind === 'line') {
    params.set('basis', 'line');
    params.set('lineId', basis.lineId);
    params.set('target', String(round4(basis.targetCanonical)));
  } else {
    params.set('basis', 'preset');
    if (basis.selections.length > 0) {
      params.set(
        'sel',
        formatPresetSelectionParam(
          basis.selections.map((s) => ({ presetId: s.presetId, quantity: s.quantity })),
        ),
      );
    }
    if (basis.extraGrams > 0) params.set('extra', String(round4(basis.extraGrams)));
  }
  return `?${params.toString()}`;
}
