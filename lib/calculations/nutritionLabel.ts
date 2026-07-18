import { NUTRIENT_KEYS, type NutrientKey, type NutrientTotals } from './nutrition';

/**
 * Nutrition LABEL layer (Recipes 2.0 Fase 6, plan §7.4 steps 4–5) — pure.
 *
 * Separates label presentation from internal precision: `recipeNutrition`
 * keeps full-precision totals; THIS module applies the FDA 2016 Daily Values
 * and the 21 CFR 101.9 rounding increments to produce display values.
 *
 * Owner decisions D2/D3 (docs/recipes-v2-fase6-plan.md): a single hard-coded
 * FDA 2016 adult DV table (no per-org selector yet; an EU 1169/2011 label is
 * a noted follow-up), rounding applied ONLY here, and everything presented as
 * an ESTIMATE — this module makes no compliance claim whatsoever (risk §19.1
 * of the master plan).
 *
 * `null` in = `null` out: an unknown nutrient renders as unknown, never 0.
 */

/**
 * FDA 2016 adult Daily Values, in each nutrient's own unit. `null` = no DV
 * (calories are a 2000 kcal reference, not a %DV; trans fat, total sugars and
 * caffeine have no DV), so no % is ever shown for them (plan §7.4 step 4).
 */
export const FDA_2016_DAILY_VALUES: Record<NutrientKey, number | null> = {
  caloriesKcal: null,
  totalFatG: 78,
  saturatedFatG: 20,
  transFatG: null,
  cholesterolMg: 300,
  sodiumMg: 2300,
  totalCarbohydrateG: 275,
  dietaryFiberG: 28,
  totalSugarsG: null,
  addedSugarsG: 50,
  proteinG: 50,
  vitaminDMcg: 20,
  calciumMg: 1300,
  ironMg: 18,
  potassiumMg: 4700,
  caffeineMg: null,
};

/** One nutrient as it should appear on the label. */
export type LabelNutrient = {
  key: NutrientKey;
  /** Full-precision input value (null = unknown). */
  raw: number | null;
  /**
   * Label-rounded value (null = unknown). When `lessThan` is true the label
   * shows "less than {rounded}" per 21 CFR 101.9 (e.g. cholesterol 2–5 mg).
   */
  rounded: number | null;
  lessThan: boolean;
  /** % Daily Value rounded to a whole percent; null = no DV or unknown. */
  dvPercent: number | null;
};

function roundToIncrement(value: number, increment: number): number {
  const r = Math.round(value / increment) * increment;
  // Avoid float dust like 2.5000000000000004.
  return Number(r.toFixed(4));
}

/**
 * 21 CFR 101.9 rounding for one nutrient. Returns the label value plus the
 * "less than" flag. Invalid input (negative/non-finite) is treated as unknown.
 */
export function roundNutrientForLabel(
  key: NutrientKey,
  value: number | null,
): { rounded: number | null; lessThan: boolean } {
  if (value == null || !Number.isFinite(value) || value < 0) {
    return { rounded: null, lessThan: false };
  }
  switch (key) {
    case 'caloriesKcal':
      if (value < 5) return { rounded: 0, lessThan: false };
      if (value <= 50) return { rounded: roundToIncrement(value, 5), lessThan: false };
      return { rounded: roundToIncrement(value, 10), lessThan: false };
    case 'totalFatG':
    case 'saturatedFatG':
    case 'transFatG':
      if (value < 0.5) return { rounded: 0, lessThan: false };
      if (value < 5) return { rounded: roundToIncrement(value, 0.5), lessThan: false };
      return { rounded: roundToIncrement(value, 1), lessThan: false };
    case 'cholesterolMg':
      if (value < 2) return { rounded: 0, lessThan: false };
      if (value <= 5) return { rounded: 5, lessThan: true };
      return { rounded: roundToIncrement(value, 5), lessThan: false };
    case 'sodiumMg':
    case 'potassiumMg':
      if (value < 5) return { rounded: 0, lessThan: false };
      if (value <= 140) return { rounded: roundToIncrement(value, 5), lessThan: false };
      return { rounded: roundToIncrement(value, 10), lessThan: false };
    case 'totalCarbohydrateG':
    case 'dietaryFiberG':
    case 'totalSugarsG':
    case 'addedSugarsG':
    case 'proteinG':
      if (value < 0.5) return { rounded: 0, lessThan: false };
      if (value < 1) return { rounded: 1, lessThan: true };
      return { rounded: roundToIncrement(value, 1), lessThan: false };
    case 'vitaminDMcg':
      return { rounded: roundToIncrement(value, 0.1), lessThan: false };
    case 'calciumMg':
    case 'ironMg':
      return {
        rounded: roundToIncrement(value, key === 'ironMg' ? 0.1 : 10),
        lessThan: false,
      };
    case 'caffeineMg':
      return { rounded: roundToIncrement(value, 1), lessThan: false };
  }
}

/**
 * % Daily Value for one nutrient, rounded to a whole percent — computed from
 * the FULL-PRECISION value (never from the rounded label value). Null when
 * the nutrient has no DV or the value is unknown/invalid.
 */
export function dvPercent(key: NutrientKey, value: number | null): number | null {
  const dv = FDA_2016_DAILY_VALUES[key];
  if (dv === null) return null;
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return Math.round((value / dv) * 100);
}

/** Build the full label row set (fixed nutrient order) for one serving. */
export function nutritionLabelRows(perServing: NutrientTotals): LabelNutrient[] {
  return NUTRIENT_KEYS.map((key) => {
    const raw = perServing[key];
    const { rounded, lessThan } = roundNutrientForLabel(key, raw);
    return { key, raw, rounded, lessThan, dvPercent: dvPercent(key, raw) };
  });
}
