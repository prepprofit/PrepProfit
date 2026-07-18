import { describe, expect, it } from 'vitest';

import { NUTRIENT_KEYS, type NutrientKey, type NutrientTotals } from './nutrition';
import {
  FDA_2016_DAILY_VALUES,
  dvPercent,
  nutritionLabelRows,
  roundNutrientForLabel,
} from './nutritionLabel';

describe('roundNutrientForLabel — calories', () => {
  it('<5 → 0, ≤50 → nearest 5, >50 → nearest 10', () => {
    expect(roundNutrientForLabel('caloriesKcal', 4.9)).toEqual({ rounded: 0, lessThan: false });
    expect(roundNutrientForLabel('caloriesKcal', 47)).toEqual({ rounded: 45, lessThan: false });
    expect(roundNutrientForLabel('caloriesKcal', 50)).toEqual({ rounded: 50, lessThan: false });
    expect(roundNutrientForLabel('caloriesKcal', 253)).toEqual({ rounded: 250, lessThan: false });
    expect(roundNutrientForLabel('caloriesKcal', 255)).toEqual({ rounded: 260, lessThan: false });
  });
});

describe('roundNutrientForLabel — fats', () => {
  it('<0.5 → 0, <5 → nearest 0.5, ≥5 → nearest 1', () => {
    expect(roundNutrientForLabel('totalFatG', 0.4)).toEqual({ rounded: 0, lessThan: false });
    expect(roundNutrientForLabel('totalFatG', 2.3)).toEqual({ rounded: 2.5, lessThan: false });
    expect(roundNutrientForLabel('totalFatG', 4.9)).toEqual({ rounded: 5, lessThan: false });
    expect(roundNutrientForLabel('saturatedFatG', 7.4)).toEqual({ rounded: 7, lessThan: false });
    expect(roundNutrientForLabel('transFatG', 0.6)).toEqual({ rounded: 0.5, lessThan: false });
  });
});

describe('roundNutrientForLabel — cholesterol', () => {
  it('<2 → 0, 2–5 → "less than 5", >5 → nearest 5', () => {
    expect(roundNutrientForLabel('cholesterolMg', 1.9)).toEqual({ rounded: 0, lessThan: false });
    expect(roundNutrientForLabel('cholesterolMg', 3)).toEqual({ rounded: 5, lessThan: true });
    expect(roundNutrientForLabel('cholesterolMg', 5)).toEqual({ rounded: 5, lessThan: true });
    expect(roundNutrientForLabel('cholesterolMg', 12)).toEqual({ rounded: 10, lessThan: false });
  });
});

describe('roundNutrientForLabel — sodium & potassium', () => {
  it('<5 → 0, ≤140 → nearest 5, >140 → nearest 10', () => {
    expect(roundNutrientForLabel('sodiumMg', 4)).toEqual({ rounded: 0, lessThan: false });
    expect(roundNutrientForLabel('sodiumMg', 137)).toEqual({ rounded: 135, lessThan: false });
    expect(roundNutrientForLabel('sodiumMg', 146)).toEqual({ rounded: 150, lessThan: false });
    expect(roundNutrientForLabel('potassiumMg', 468)).toEqual({ rounded: 470, lessThan: false });
  });
});

describe('roundNutrientForLabel — carbs/fiber/sugars/protein', () => {
  it('<0.5 → 0, <1 → "less than 1", ≥1 → nearest 1', () => {
    for (const k of [
      'totalCarbohydrateG',
      'dietaryFiberG',
      'totalSugarsG',
      'addedSugarsG',
      'proteinG',
    ] as NutrientKey[]) {
      expect(roundNutrientForLabel(k, 0.4)).toEqual({ rounded: 0, lessThan: false });
      expect(roundNutrientForLabel(k, 0.7)).toEqual({ rounded: 1, lessThan: true });
      expect(roundNutrientForLabel(k, 23.6)).toEqual({ rounded: 24, lessThan: false });
    }
  });
});

describe('roundNutrientForLabel — vitamins/minerals/caffeine', () => {
  it('uses per-nutrient increments', () => {
    expect(roundNutrientForLabel('vitaminDMcg', 2.34)).toEqual({ rounded: 2.3, lessThan: false });
    expect(roundNutrientForLabel('calciumMg', 263)).toEqual({ rounded: 260, lessThan: false });
    expect(roundNutrientForLabel('ironMg', 2.34)).toEqual({ rounded: 2.3, lessThan: false });
    expect(roundNutrientForLabel('caffeineMg', 63.4)).toEqual({ rounded: 63, lessThan: false });
  });
});

describe('roundNutrientForLabel — unknown/invalid', () => {
  it('null, negative, NaN, Infinity all stay unknown (never 0)', () => {
    for (const v of [null, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(roundNutrientForLabel('caloriesKcal', v)).toEqual({
        rounded: null,
        lessThan: false,
      });
    }
  });
});

describe('dvPercent', () => {
  it('computes from full precision and rounds to a whole percent', () => {
    expect(dvPercent('sodiumMg', 1150)).toBe(50);
    expect(dvPercent('totalFatG', 7.8)).toBe(10);
    expect(dvPercent('ironMg', 1.7)).toBe(9); // 9.44 → 9
  });

  it('no DV → null (calories, trans fat, total sugars, caffeine)', () => {
    expect(dvPercent('caloriesKcal', 2000)).toBeNull();
    expect(dvPercent('transFatG', 1)).toBeNull();
    expect(dvPercent('totalSugarsG', 10)).toBeNull();
    expect(dvPercent('caffeineMg', 100)).toBeNull();
  });

  it('unknown/invalid value → null', () => {
    expect(dvPercent('sodiumMg', null)).toBeNull();
    expect(dvPercent('sodiumMg', Number.NaN)).toBeNull();
    expect(dvPercent('sodiumMg', -5)).toBeNull();
  });

  it('0 is a real 0%, not unknown', () => {
    expect(dvPercent('sodiumMg', 0)).toBe(0);
  });
});

describe('nutritionLabelRows', () => {
  it('emits every nutrient in fixed order, nulls preserved', () => {
    const perServing = {} as NutrientTotals;
    for (const k of NUTRIENT_KEYS) perServing[k] = null;
    perServing.caloriesKcal = 253;
    perServing.sodiumMg = 1150;

    const rows = nutritionLabelRows(perServing);
    expect(rows.map((r) => r.key)).toEqual([...NUTRIENT_KEYS]);

    const cal = rows.find((r) => r.key === 'caloriesKcal');
    expect(cal).toMatchObject({ raw: 253, rounded: 250, dvPercent: null });
    const na = rows.find((r) => r.key === 'sodiumMg');
    expect(na).toMatchObject({ raw: 1150, rounded: 1150, dvPercent: 50 });
    const fat = rows.find((r) => r.key === 'totalFatG');
    expect(fat).toMatchObject({ raw: null, rounded: null, dvPercent: null });
  });

  it('%DV comes from raw, not from the rounded label value', () => {
    const perServing = {} as NutrientTotals;
    for (const k of NUTRIENT_KEYS) perServing[k] = null;
    perServing.dietaryFiberG = 0.7; // label shows "less than 1"
    const row = nutritionLabelRows(perServing).find((r) => r.key === 'dietaryFiberG');
    expect(row).toMatchObject({ rounded: 1, lessThan: true, dvPercent: 3 }); // 0.7/28=2.5%→3%
  });
});

describe('FDA_2016_DAILY_VALUES', () => {
  it('covers every nutrient key', () => {
    for (const k of NUTRIENT_KEYS) {
      expect(FDA_2016_DAILY_VALUES[k] === null || FDA_2016_DAILY_VALUES[k]! > 0).toBe(true);
    }
  });
});
