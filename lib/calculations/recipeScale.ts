/**
 * Recipe scaling — pure math (Recipe scaling MVP). No I/O, no DB.
 *
 * Scaling resizes an existing recipe to a different batch size and recomputes its
 * ingredient lines. It is DERIVE-ON-READ only: nothing here is persisted, no scale
 * factor is stored. This module is deliberately SEPARATE from production explosion
 * (lib/calculations/production.ts): production applies yield/loss and aggregates for
 * stock consumption; recipe scaling simply multiplies the recipe's lines by a factor
 * and keeps `yieldPercentage` as untouched recipe metadata.
 *
 * Quantities are canonical (g / ml / count). Accumulate/derive with UNROUNDED
 * numbers, then round scaled canonical quantities ONCE to 2 decimals for
 * display/export — matching `recipe_ingredients.quantity numeric(10,2)`.
 */

/** Max canonical quantity a scaled recipe line may reach (numeric(10,2) domain). */
export const RECIPE_SCALE_QUANTITY_MAX = 99_999_999.99;

export type RecipeScaleMode =
  /** User entered the desired portions: `factor = targetPortions / yieldPortions`. */
  | { kind: 'portions'; targetPortions: number }
  /** User pinned one line to a target amount (in canonical units):
   *  `factor = targetCanonical / anchorLineQuantity`. */
  | { kind: 'anchor'; anchorLineQuantity: number; targetCanonical: number }
  /** User scaled to a TARGET FINISHED WEIGHT (kitchen presets, Recipe-editor
   *  parity): `factor = targetWeightGrams / baseWeightGrams`. Both are canonical
   *  grams; `baseWeightGrams` is the recipe's `yield_weight_grams` and must be set
   *  (a recipe with no batch yield weight has nothing to scale from → invalid_yield). */
  | { kind: 'yieldWeight'; baseWeightGrams: number; targetWeightGrams: number };

export type RecipeScaleResult =
  | { ok: true; factor: number; scaledPortions: number }
  | {
      ok: false;
      reason:
        | 'invalid_target'
        | 'invalid_anchor'
        | 'invalid_yield'
        | 'invalid_factor'
        | 'overflow';
    };

/** A finite, strictly-positive real number (rejects 0, negatives, NaN, ±Infinity). */
function isPositiveFinite(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/** One preset line in a scaling basket: a per-unit target weight and a count. */
export type PresetBasketLine = {
  /** Canonical per-unit target finished weight (grams). */
  targetWeightGrams: number;
  /** How many of this preset to make (whole or fractional; ≤ 0 / NaN counts as 0). */
  quantity: number;
};

/**
 * Sum a kitchen-preset basket plus an optional loose weight into ONE canonical target
 * weight (grams), the way the reference Kitchen Scale composes a batch. Each line
 * contributes `targetWeightGrams × quantity`; a non-positive/non-finite quantity or
 * per-unit weight contributes 0 (an unfilled row is simply ignored, never an error).
 * `extraGrams` is the loose "custom total weight" added on top (same forgiving rule).
 * Returns 0 when nothing is entered — callers treat that as "no result yet".
 */
export function sumPresetBasketGrams(
  lines: readonly PresetBasketLine[],
  extraGrams = 0,
): number {
  const contribution = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  let total = contribution(extraGrams);
  for (const line of lines) {
    total += contribution(line.targetWeightGrams) * contribution(line.quantity);
  }
  return total;
}

/** Round a canonical quantity once to 2 decimals (the numeric(10,2) boundary). */
export function roundCanonical(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Scale one canonical line quantity by `factor`, rounded once to 2 decimals. */
export function scaleLineQuantity(quantity: number, factor: number): number {
  return roundCanonical(quantity * factor);
}

/** Scale a money amount (integer cents) by `factor`, rounded to whole cents. */
export function scaleMoneyCents(cents: number, factor: number): number {
  return Math.round(cents * factor);
}

/**
 * Derive the scale factor + resulting portions for a recipe, validating every input
 * and guarding against overflow on any scaled line. Pass the recipe's canonical line
 * quantities so the overflow guard can reject a factor that would push any line above
 * `RECIPE_SCALE_QUANTITY_MAX`. A factor of exactly 1 is the identity.
 */
export function deriveScale(
  yieldPortions: number,
  mode: RecipeScaleMode,
  lineQuantities: readonly number[] = [],
): RecipeScaleResult {
  if (!isPositiveFinite(yieldPortions)) {
    return { ok: false, reason: 'invalid_yield' };
  }

  let factor: number;
  if (mode.kind === 'portions') {
    if (!isPositiveFinite(mode.targetPortions)) {
      return { ok: false, reason: 'invalid_target' };
    }
    factor = mode.targetPortions / yieldPortions;
  } else if (mode.kind === 'anchor') {
    if (
      !isPositiveFinite(mode.anchorLineQuantity) ||
      !isPositiveFinite(mode.targetCanonical)
    ) {
      return { ok: false, reason: 'invalid_anchor' };
    }
    factor = mode.targetCanonical / mode.anchorLineQuantity;
  } else {
    // yieldWeight: a missing/zero base weight means the recipe has no usable batch
    // size to scale from (invalid_yield); a bad target is invalid_target.
    if (!isPositiveFinite(mode.baseWeightGrams)) {
      return { ok: false, reason: 'invalid_yield' };
    }
    if (!isPositiveFinite(mode.targetWeightGrams)) {
      return { ok: false, reason: 'invalid_target' };
    }
    factor = mode.targetWeightGrams / mode.baseWeightGrams;
  }

  if (!isPositiveFinite(factor)) {
    return { ok: false, reason: 'invalid_factor' };
  }

  // Reject before exposing any scaled line beyond the storage/display domain.
  for (const q of lineQuantities) {
    if (q * factor > RECIPE_SCALE_QUANTITY_MAX) {
      return { ok: false, reason: 'overflow' };
    }
  }

  const scaledPortions = yieldPortions * factor;
  if (!Number.isFinite(scaledPortions)) {
    return { ok: false, reason: 'invalid_factor' };
  }

  return { ok: true, factor, scaledPortions };
}
