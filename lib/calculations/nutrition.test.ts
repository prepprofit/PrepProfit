import { describe, expect, it } from 'vitest';

import {
  NUTRIENT_KEYS,
  nutrientForLine,
  recipeNutrition,
  type NutrientKey,
  type NutritionProfile,
  type RecipeNutritionResult,
} from './nutrition';

/** Profile where every nutrient is `value`, per 100 g. */
function flatProfile(value: number | null, basisGrams = 100): NutritionProfile {
  const values = {} as Record<NutrientKey, number | null>;
  for (const k of NUTRIENT_KEYS) values[k] = value;
  return { basisGrams, values };
}

function line(
  overrides: Partial<{
    ingredientId: string;
    ingredientName: string;
    edibleWeightGrams: number | null;
    profile: NutritionProfile | null;
  }> = {},
) {
  return {
    ingredientId: 'ing-1',
    ingredientName: 'Flour',
    edibleWeightGrams: 200,
    profile: flatProfile(10),
    ...overrides,
  };
}

describe('nutrientForLine', () => {
  it('scales the per-basis value by the edible weight', () => {
    expect(nutrientForLine(10, 100, 250)).toBe(25);
  });

  it('respects a non-100 basis', () => {
    expect(nutrientForLine(10, 50, 100)).toBe(20);
  });

  it('returns 0 for a zero weight, not null', () => {
    expect(nutrientForLine(10, 100, 0)).toBe(0);
  });

  it('null value stays null (unknown, never 0)', () => {
    expect(nutrientForLine(null, 100, 250)).toBeNull();
  });

  it('rejects negative, NaN and Infinity inputs as unknown', () => {
    expect(nutrientForLine(-1, 100, 250)).toBeNull();
    expect(nutrientForLine(Number.NaN, 100, 250)).toBeNull();
    expect(nutrientForLine(Number.POSITIVE_INFINITY, 100, 250)).toBeNull();
    expect(nutrientForLine(10, 0, 250)).toBeNull();
    expect(nutrientForLine(10, -100, 250)).toBeNull();
    expect(nutrientForLine(10, Number.NaN, 250)).toBeNull();
    expect(nutrientForLine(10, 100, -5)).toBeNull();
    expect(nutrientForLine(10, 100, Number.NaN)).toBeNull();
  });
});

describe('recipeNutrition — direct lines', () => {
  it('sums two known lines and is complete with a serving', () => {
    const r = recipeNutrition({
      lines: [
        line({ edibleWeightGrams: 100, profile: flatProfile(10) }),
        line({ ingredientId: 'ing-2', edibleWeightGrams: 50, profile: flatProfile(20) }),
      ],
      servingFraction: 0.5,
    });
    expect(r.status).toBe('complete');
    expect(r.issues).toEqual([]);
    expect(r.totals.caloriesKcal).toBe(20);
    expect(r.perServing?.caloriesKcal).toBe(10);
  });

  it('an unknown nutrient poisons ONLY that nutrient, never becomes 0', () => {
    const partial = flatProfile(10);
    partial.values.sodiumMg = null;
    const r = recipeNutrition({
      lines: [line({ profile: partial }), line({ ingredientId: 'ing-2' })],
      servingFraction: 1,
    });
    expect(r.totals.sodiumMg).toBeNull();
    expect(r.totals.caloriesKcal).toBe(40); // 10*200/100 twice
    // A null nutrient inside an existing profile is NOT a completeness issue.
    expect(r.status).toBe('complete');
    expect(r.perServing?.sodiumMg).toBeNull();
  });

  it('null poisoning is order-independent', () => {
    const partial = flatProfile(10);
    partial.values.ironMg = null;
    const first = recipeNutrition({
      lines: [line({ profile: partial }), line({ ingredientId: 'ing-2' })],
      servingFraction: 1,
    });
    const second = recipeNutrition({
      lines: [line({ ingredientId: 'ing-2' }), line({ profile: partial })],
      servingFraction: 1,
    });
    expect(first.totals.ironMg).toBeNull();
    expect(second.totals.ironMg).toBeNull();
  });

  it('missing profile → incomplete with NO_PROFILE naming the ingredient', () => {
    const r = recipeNutrition({
      lines: [line({ profile: null, ingredientName: 'Mystery' })],
      servingFraction: 1,
    });
    expect(r.status).toBe('incomplete');
    expect(r.issues).toEqual([
      { reason: 'NO_PROFILE', refId: 'ing-1', refName: 'Mystery' },
    ]);
  });

  it('missing weight (volume/count without equivalency) → NO_WEIGHT_EQUIVALENCY', () => {
    const r = recipeNutrition({
      lines: [line({ edibleWeightGrams: null })],
      servingFraction: 1,
    });
    expect(r.status).toBe('incomplete');
    expect(r.issues[0]?.reason).toBe('NO_WEIGHT_EQUIVALENCY');
  });

  it('zero/negative/NaN weight is as blocking as a missing one', () => {
    for (const w of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = recipeNutrition({ lines: [line({ edibleWeightGrams: w })], servingFraction: 1 });
      expect(r.status).toBe('incomplete');
      expect(r.issues[0]?.reason).toBe('NO_WEIGHT_EQUIVALENCY');
    }
  });

  it('duplicate issues for the same ingredient are deduplicated', () => {
    const r = recipeNutrition({
      lines: [line({ profile: null }), line({ profile: null })],
      servingFraction: 1,
    });
    expect(r.issues).toHaveLength(1);
  });

  it('an empty recipe is incomplete with all-null totals', () => {
    const r = recipeNutrition({ lines: [], servingFraction: 1 });
    expect(r.status).toBe('incomplete');
    for (const k of NUTRIENT_KEYS) expect(r.totals[k]).toBeNull();
  });
});

describe('recipeNutrition — serving fraction', () => {
  it('no serving → NO_NUTRITION_SERVING, perServing null, totals still there', () => {
    const r = recipeNutrition({ lines: [line()], servingFraction: null });
    expect(r.status).toBe('incomplete');
    expect(r.issues).toEqual([
      { reason: 'NO_NUTRITION_SERVING', refId: null, refName: null },
    ]);
    expect(r.perServing).toBeNull();
    expect(r.totals.caloriesKcal).toBe(20);
  });

  it('zero/negative/NaN fraction blocks like a missing one', () => {
    for (const f of [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = recipeNutrition({ lines: [line()], servingFraction: f });
      expect(r.perServing).toBeNull();
      expect(r.issues[0]?.reason).toBe('NO_NUTRITION_SERVING');
    }
  });
});

describe('recipeNutrition — sub-recipe components', () => {
  function childResult(
    value: number | null,
    status: RecipeNutritionResult['status'] = 'complete',
  ): RecipeNutritionResult {
    const totals = {} as Record<NutrientKey, number | null>;
    for (const k of NUTRIENT_KEYS) totals[k] = value;
    return { status, totals, perServing: null, issues: [] };
  }

  it('scales child totals by usedWeight / yieldWeight', () => {
    const r = recipeNutrition({
      lines: [],
      components: [
        {
          recipeId: 'sub-1',
          recipeName: 'Sauce',
          yieldWeightGrams: 1000,
          usedWeightGrams: 250,
          child: childResult(100),
        },
      ],
      servingFraction: 1,
    });
    expect(r.status).toBe('complete');
    expect(r.totals.caloriesKcal).toBe(25);
  });

  it('incomplete child contaminates the parent but its known totals still add', () => {
    const r = recipeNutrition({
      lines: [line({ edibleWeightGrams: 100 })], // contributes 10
      components: [
        {
          recipeId: 'sub-1',
          recipeName: 'Sauce',
          yieldWeightGrams: 1000,
          usedWeightGrams: 500,
          child: childResult(100, 'incomplete'),
        },
      ],
      servingFraction: 1,
    });
    expect(r.status).toBe('incomplete');
    expect(r.issues).toContainEqual({
      reason: 'SUBRECIPE_INCOMPLETE',
      refId: 'sub-1',
      refName: 'Sauce',
    });
    expect(r.totals.caloriesKcal).toBe(60); // 10 + 100*0.5
  });

  it('child unknown nutrient stays unknown in the parent', () => {
    const r = recipeNutrition({
      lines: [line()],
      components: [
        {
          recipeId: 'sub-1',
          recipeName: 'Sauce',
          yieldWeightGrams: 500,
          usedWeightGrams: 500,
          child: childResult(null),
        },
      ],
      servingFraction: 1,
    });
    expect(r.totals.caloriesKcal).toBeNull();
    expect(r.status).toBe('complete'); // unknown nutrients ≠ incompleteness
  });

  it('component without weights → NO_WEIGHT_EQUIVALENCY on the sub-recipe', () => {
    const r = recipeNutrition({
      lines: [],
      components: [
        {
          recipeId: 'sub-1',
          recipeName: 'Sauce',
          yieldWeightGrams: null,
          usedWeightGrams: 250,
          child: childResult(100),
        },
      ],
      servingFraction: 1,
    });
    expect(r.status).toBe('incomplete');
    expect(r.issues[0]).toEqual({
      reason: 'NO_WEIGHT_EQUIVALENCY',
      refId: 'sub-1',
      refName: 'Sauce',
    });
  });
});
