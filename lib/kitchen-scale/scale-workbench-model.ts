import type { Dimension } from '@/lib/units';
import {
  deriveScale,
  scaleLineQuantity,
  sumPresetBasketGrams,
  type PresetBasketLine,
  type RecipeScaleResult,
} from '@/lib/calculations/recipeScale';
import { scalePortionsSchema } from '@/lib/validation/recipe-scale';

/**
 * Pure Kitchen Scale workbench model — no React, no I/O, testable in the node
 * Vitest environment. The component owns input text/focus/layout; this module
 * owns the deterministic scale result. All arithmetic delegates to
 * lib/calculations/recipeScale; nothing is reimplemented here.
 */

/** The operational recipe facts the workbench scales from (money-free). */
export type WorkbenchRecipe = {
  yieldPortions: number;
  /** Canonical batch yield weight (grams); null = weight scaling unavailable. */
  yieldWeightGrams: number | null;
};

/** One recipe line the workbench scales / anchors on (money-free). */
export type WorkbenchLine = {
  id: string;
  ingredientId: string;
  name: string;
  dimension: Dimension;
  /** Canonical amount (g / ml / count). */
  quantity: number;
};

export type BasketInput = {
  presetQuantities: PresetBasketLine[];
  customWeightGrams: number;
};

export type ScaledLine = WorkbenchLine;

/** Preset basket + loose custom weight → one canonical target weight (grams). */
export function basketTargetGrams(input: BasketInput): number {
  return sumPresetBasketGrams(input.presetQuantities, input.customWeightGrams);
}

/** Scale to a target finished weight (`factor = target / yieldWeightGrams`). */
export function scaleFromBasket(
  recipe: WorkbenchRecipe,
  lines: readonly WorkbenchLine[],
  basket: BasketInput,
): RecipeScaleResult {
  return deriveScale(
    recipe.yieldPortions,
    {
      kind: 'yieldWeight',
      baseWeightGrams: recipe.yieldWeightGrams ?? 0,
      targetWeightGrams: basketTargetGrams(basket),
    },
    lines.map((l) => l.quantity),
  );
}

/** Re-anchor the whole scale on one edited ingredient quantity (canonical). */
export function scaleFromAnchor(
  recipe: WorkbenchRecipe,
  lines: readonly WorkbenchLine[],
  anchorLineId: string,
  targetCanonical: number,
): RecipeScaleResult {
  const anchor = lines.find((l) => l.id === anchorLineId);
  if (!anchor) return { ok: false, reason: 'invalid_anchor' };
  return deriveScale(
    recipe.yieldPortions,
    {
      kind: 'anchor',
      anchorLineQuantity: anchor.quantity,
      targetCanonical,
    },
    lines.map((l) => l.quantity),
  );
}

/** Every line multiplied by `factor`, rounded once at the canonical boundary. */
export function scaledLines(
  lines: readonly WorkbenchLine[],
  factor: number,
): ScaledLine[] {
  return lines.map((l) => ({
    ...l,
    quantity: scaleLineQuantity(l.quantity, factor),
  }));
}

/**
 * The `?portions=` value for the prep-card print/PDF links, or null when the
 * scale is not exportable. Rounds to the 4-decimal URL precision, then delegates
 * the cap/precision/positivity contract to the EXISTING `scalePortionsSchema`
 * (the same schema the export routes validate with), so the workbench can never
 * build a link the server would reject.
 */
export function portionsParamFor(scale: RecipeScaleResult): string | null {
  if (!scale.ok) return null;
  const rounded = Math.round(scale.scaledPortions * 10000) / 10000;
  const param = String(rounded);
  return scalePortionsSchema.safeParse(param).success ? param : null;
}
