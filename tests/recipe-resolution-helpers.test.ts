import { describe, expect, it } from 'vitest';
import {
  CREATE_NEW,
  UNRESOLVED,
  initResolutionChoices,
  buildResolutions,
  countUnresolved,
  countDimensionMismatches,
} from '@/app/(app)/import/recipe-resolution';
import type { IngredientOption } from '@/lib/data/ingredients';
import type { ImportRecipePayload } from '@/lib/import/types';

const payload: ImportRecipePayload = {
  recipes: [
    {
      name: 'Cake',
      yieldPortions: 1,
      yieldPercentage: 100,
      notes: null,
      lines: [
        { ingredientName: 'Caster Sugar', normalizedName: 'caster sugar', quantityCanonical: 200, dimension: 'weight' },
        { ingredientName: 'Flour', normalizedName: 'flour', quantityCanonical: 300, dimension: 'weight' },
        { ingredientName: 'Milk', normalizedName: 'milk', quantityCanonical: 250, dimension: 'volume' },
      ],
    },
  ],
  resolutions: {
    flour: { kind: 'exact', ingredientId: 'i_flour', ingredientName: 'Flour' },
    'caster sugar': { kind: 'fuzzy', suggestions: [{ ingredientId: 'i_sugar', name: 'Sugar', score: 0.72 }] },
    milk: { kind: 'new' },
  },
};

const options: IngredientOption[] = [
  { id: 'i_flour', name: 'Flour', dimension: 'weight' },
  { id: 'i_sugar', name: 'Sugar', dimension: 'weight' },
  { id: 'i_milk_vol', name: 'Whole Milk', dimension: 'volume' },
  { id: 'i_milk_wt', name: 'Milk Powder', dimension: 'weight' },
];

describe('initResolutionChoices', () => {
  it('seeds only NON-exact names to UNRESOLVED', () => {
    const init = initResolutionChoices(payload);
    expect(init).toEqual({ 'caster sugar': UNRESOLVED, milk: UNRESOLVED });
    expect(init.flour).toBeUndefined(); // exact is auto-linked server-side
  });

  it('returns empty for an undefined payload', () => {
    expect(initResolutionChoices(undefined)).toEqual({});
  });
});

describe('countUnresolved', () => {
  it('counts non-exact names still UNRESOLVED', () => {
    expect(countUnresolved(payload, initResolutionChoices(payload))).toBe(2);
    expect(
      countUnresolved(payload, { 'caster sugar': 'i_sugar', milk: CREATE_NEW }),
    ).toBe(0);
  });
});

describe('buildResolutions', () => {
  it('drops UNRESOLVED entries and maps the rest', () => {
    const built = buildResolutions({ 'caster sugar': 'i_sugar', milk: CREATE_NEW, flour: UNRESOLVED });
    expect(built).toEqual(
      expect.arrayContaining([
        { name: 'caster sugar', action: 'link', ingredientId: 'i_sugar' },
        { name: 'milk', action: 'create' },
      ]),
    );
    expect(built).toHaveLength(2);
    expect(built.some((c) => c.name === 'flour')).toBe(false);
  });
});

describe('countDimensionMismatches', () => {
  it('flags a link whose dimension conflicts with the line', () => {
    // milk line is volume; linking to a weight ingredient is incompatible.
    expect(
      countDimensionMismatches(payload, { milk: 'i_milk_wt' }, options),
    ).toBe(1);
  });

  it('accepts a dimension-compatible link and ignores create/unresolved', () => {
    expect(countDimensionMismatches(payload, { milk: 'i_milk_vol' }, options)).toBe(0);
    expect(countDimensionMismatches(payload, { milk: CREATE_NEW }, options)).toBe(0);
    expect(countDimensionMismatches(payload, { milk: UNRESOLVED }, options)).toBe(0);
  });
});
