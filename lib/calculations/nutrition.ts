/**
 * Recipe nutrition rollup (Recipes 2.0 Fase 6, plan §7.4). Pure, no I/O —
 * derive-on-read like `recipeCost` and `recipeAllergens`.
 *
 * Honesty rules (non-negotiable, plan §7.4 + CLAUDE.md):
 *  - `null` = UNKNOWN, never zero. A nutrient missing from any contributing
 *    line makes THAT nutrient's total null — absent values are never summed
 *    as a silent 0.
 *  - A line without a resolvable edible weight in grams, or without a
 *    nutrition profile, makes the whole calc INCOMPLETE (with an actionable
 *    reason), and an incomplete sub-recipe contaminates its parent.
 *  - Totals stay at full internal precision; label rounding lives in a
 *    separate layer (lib/calculations/nutritionLabel.ts).
 */

/** The 17 nutrient columns of `ingredient_nutrition_profiles`, in label order. */
export const NUTRIENT_KEYS = [
  'caloriesKcal',
  'totalFatG',
  'saturatedFatG',
  'transFatG',
  'cholesterolMg',
  'sodiumMg',
  'totalCarbohydrateG',
  'dietaryFiberG',
  'totalSugarsG',
  'addedSugarsG',
  'proteinG',
  'vitaminDMcg',
  'calciumMg',
  'ironMg',
  'potassiumMg',
  'caffeineMg',
] as const;

export type NutrientKey = (typeof NUTRIENT_KEYS)[number];

/** Nutrient amounts per `basisGrams` of edible weight; null = unknown. */
export type NutritionProfile = {
  /** Reference mass the nutrient values describe (schema default 100 g). */
  basisGrams: number;
  values: Record<NutrientKey, number | null>;
};

/** Per-nutrient totals; null = at least one contributor is unknown. */
export type NutrientTotals = Record<NutrientKey, number | null>;

/** Why a line/component keeps the calc incomplete — actionable in the UI. */
export type NutritionIssueReason =
  | 'NO_PROFILE'
  | 'NO_WEIGHT_EQUIVALENCY'
  | 'SUBRECIPE_INCOMPLETE'
  | 'NO_NUTRITION_SERVING';

export type NutritionIssue = {
  reason: NutritionIssueReason;
  /** Ingredient or sub-recipe id the user must fix (null for recipe-level). */
  refId: string | null;
  refName: string | null;
};

/** One direct ingredient line, as fed to the rollup. */
export type NutritionLine = {
  ingredientId: string;
  ingredientName: string;
  /**
   * Edible weight in grams actually used by the recipe (post prep-loss, i.e.
   * the quantity the diner eats). `null` = the line is in volume/count with no
   * weight equivalency — the calc cannot proceed for this line.
   */
  edibleWeightGrams: number | null;
  /** Active nutrition profile, or null when the ingredient has none. */
  profile: NutritionProfile | null;
};

/** One sub-recipe component line: the child's own rollup, scaled by weight. */
export type NutritionComponent = {
  recipeId: string;
  recipeName: string;
  /** Finished weight of the child batch the totals describe, in grams. */
  yieldWeightGrams: number | null;
  /** Finished weight of the child actually used by the parent, in grams. */
  usedWeightGrams: number | null;
  /** The child's own rollup (recursion happens in the resolver, not here). */
  child: RecipeNutritionResult;
};

export type RecipeNutritionResult = {
  status: 'complete' | 'incomplete';
  /** Whole-batch totals at full precision; per-nutrient null = unknown. */
  totals: NutrientTotals;
  /**
   * Totals for one nutrition serving (`totals × servingFraction`), or null
   * when no nutrition serving is defined.
   */
  perServing: NutrientTotals | null;
  /** Every reason the calc is not (fully) printable, deduplicated. */
  issues: NutritionIssue[];
};

function emptyTotals(): NutrientTotals {
  const t = {} as NutrientTotals;
  for (const k of NUTRIENT_KEYS) t[k] = null;
  return t;
}

function isPositiveFinite(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v) && v > 0;
}

/**
 * Nutrient contribution of one line: `value × edibleWeightGrams / basisGrams`.
 * Returns null when the profile value is unknown or the inputs are invalid.
 */
export function nutrientForLine(
  valuePerBasis: number | null,
  basisGrams: number,
  edibleWeightGrams: number,
): number | null {
  if (valuePerBasis == null) return null;
  if (!Number.isFinite(valuePerBasis) || valuePerBasis < 0) return null;
  if (!isPositiveFinite(basisGrams)) return null;
  if (!Number.isFinite(edibleWeightGrams) || edibleWeightGrams < 0) return null;
  return (valuePerBasis * edibleWeightGrams) / basisGrams;
}

/** Add a possibly-unknown contribution into a running sum (null poisons). */
function addNullable(sum: number | null, next: number | null): number | null {
  if (sum === null || next === null) return null;
  return sum + next;
}

function pushIssue(issues: NutritionIssue[], issue: NutritionIssue): void {
  const dup = issues.some(
    (i) => i.reason === issue.reason && i.refId === issue.refId,
  );
  if (!dup) issues.push(issue);
}

/**
 * Roll up a recipe's nutrition from its direct lines and sub-recipe components.
 *
 * - Direct lines contribute `per-basis value × edible grams / basis`.
 * - Components contribute the child's batch totals scaled by
 *   `usedWeightGrams / yieldWeightGrams` (proportional to the finished weight
 *   actually used, plan §7.4 step 2). An incomplete child contaminates the
 *   parent (`SUBRECIPE_INCOMPLETE`), and its unknown nutrients stay unknown.
 * - `servingFraction` is the nutrition serving's share of the whole batch
 *   (e.g. 150 g serving of a 3000 g batch = 0.05); null = no serving defined,
 *   which blocks the final label but not the batch totals.
 */
export function recipeNutrition(input: {
  lines: NutritionLine[];
  components?: NutritionComponent[];
  servingFraction?: number | null;
}): RecipeNutritionResult {
  const issues: NutritionIssue[] = [];
  const totals = emptyTotals();
  // Whether anything at all contributed — an empty recipe stays all-null.
  let contributed = false;
  // Per nutrient: has any contributor been folded in yet? Distinguishes
  // "no contributor yet" (start a sum) from "a contributor was unknown"
  // (null poisons the sum for good).
  const anySeen = {} as Record<NutrientKey, boolean>;
  for (const k of NUTRIENT_KEYS) anySeen[k] = false;

  for (const line of input.lines) {
    if (!isPositiveFinite(line.edibleWeightGrams)) {
      pushIssue(issues, {
        reason: 'NO_WEIGHT_EQUIVALENCY',
        refId: line.ingredientId,
        refName: line.ingredientName,
      });
      continue;
    }
    if (line.profile === null) {
      pushIssue(issues, {
        reason: 'NO_PROFILE',
        refId: line.ingredientId,
        refName: line.ingredientName,
      });
      continue;
    }
    contributed = true;
    for (const k of NUTRIENT_KEYS) {
      const part = nutrientForLine(
        line.profile.values[k],
        line.profile.basisGrams,
        line.edibleWeightGrams,
      );
      // First contributor initialises the sum; later nulls poison it.
      totals[k] = !anySeen[k] ? part : addNullable(totals[k], part);
      anySeen[k] = true;
    }
  }

  const components = input.components ?? [];
  for (const comp of components) {
    if (
      !isPositiveFinite(comp.usedWeightGrams) ||
      !isPositiveFinite(comp.yieldWeightGrams)
    ) {
      pushIssue(issues, {
        reason: 'NO_WEIGHT_EQUIVALENCY',
        refId: comp.recipeId,
        refName: comp.recipeName,
      });
      continue;
    }
    if (comp.child.status === 'incomplete') {
      pushIssue(issues, {
        reason: 'SUBRECIPE_INCOMPLETE',
        refId: comp.recipeId,
        refName: comp.recipeName,
      });
    }
    const factor = comp.usedWeightGrams / comp.yieldWeightGrams;
    contributed = true;
    for (const k of NUTRIENT_KEYS) {
      const childVal = comp.child.totals[k];
      const part = childVal === null ? null : childVal * factor;
      totals[k] = !anySeen[k] ? part : addNullable(totals[k], part);
      anySeen[k] = true;
    }
  }

  const servingFraction = input.servingFraction ?? null;
  let perServing: NutrientTotals | null = null;
  if (servingFraction === null) {
    pushIssue(issues, {
      reason: 'NO_NUTRITION_SERVING',
      refId: null,
      refName: null,
    });
  } else if (isPositiveFinite(servingFraction)) {
    perServing = emptyTotals();
    for (const k of NUTRIENT_KEYS) {
      const v = totals[k];
      perServing[k] = v === null ? null : v * servingFraction;
    }
  } else {
    // A zero/negative/non-finite fraction is as blocking as a missing one.
    pushIssue(issues, {
      reason: 'NO_NUTRITION_SERVING',
      refId: null,
      refName: null,
    });
  }

  return {
    status: issues.length === 0 && contributed ? 'complete' : 'incomplete',
    totals,
    perServing,
    issues,
  };
}
