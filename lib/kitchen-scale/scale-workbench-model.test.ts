import { describe, expect, it } from 'vitest';
import {
  combinedPresetTargetGrams,
  prepCardQueryFor,
  scaleForBasis,
  scaledLines,
  type CalculationBasis,
  type WorkbenchLine,
  type WorkbenchRecipe,
} from './scale-workbench-model';

const recipe: WorkbenchRecipe = { yieldPortions: 4, yieldWeightGrams: 1000 };

const lines: WorkbenchLine[] = [
  { id: 'l1', name: 'Flour', dimension: 'weight', quantity: 600, isSubRecipe: false },
  { id: 'l2', name: 'Water', dimension: 'volume', quantity: 400, isSubRecipe: false },
];

describe('combinedPresetTargetGrams', () => {
  it('sums a preset basket: 2 × 500g + 1 × 300g = 1300g', () => {
    expect(
      combinedPresetTargetGrams([
        { targetWeightGrams: 500, quantity: 2 },
        { targetWeightGrams: 300, quantity: 1 },
      ]),
    ).toBe(1300);
  });

  it('adds an extra loose weight on top', () => {
    expect(
      combinedPresetTargetGrams([{ targetWeightGrams: 500, quantity: 1 }], 250),
    ).toBe(750);
  });
});

describe('scaleForBasis — original', () => {
  it('is factor 1, identity', () => {
    expect(scaleForBasis(recipe, lines, { kind: 'original' })).toEqual({
      ok: true,
      factor: 1,
      scaledPortions: 4,
    });
  });
});

describe('scaleForBasis — target weight', () => {
  it('scales to the target finished weight', () => {
    const basis: CalculationBasis = { kind: 'weight', targetGrams: 2000 };
    expect(scaleForBasis(recipe, lines, basis)).toEqual({
      ok: true,
      factor: 2,
      scaledPortions: 8,
    });
  });

  it('a recipe with no yield weight cannot scale by weight (invalid_yield)', () => {
    const basis: CalculationBasis = { kind: 'weight', targetGrams: 500 };
    expect(
      scaleForBasis({ yieldPortions: 4, yieldWeightGrams: null }, lines, basis),
    ).toEqual({ ok: false, reason: 'invalid_yield' });
  });
});

describe('scaleForBasis — ingredient amount (anchor)', () => {
  it('recalculates the factor from the edited ingredient quantity', () => {
    // Flour 600g edited to 900g → factor 1.5, portions 6.
    const basis: CalculationBasis = {
      kind: 'line',
      lineId: 'l1',
      lineName: 'Flour',
      targetCanonical: 900,
    };
    expect(scaleForBasis(recipe, lines, basis)).toEqual({
      ok: true,
      factor: 1.5,
      scaledPortions: 6,
    });
  });

  it('an unknown line id is an anchor error, never a crash', () => {
    const basis: CalculationBasis = {
      kind: 'line',
      lineId: 'missing',
      lineName: '?',
      targetCanonical: 900,
    };
    expect(scaleForBasis(recipe, lines, basis)).toEqual({
      ok: false,
      reason: 'invalid_anchor',
    });
  });
});

describe('scaleForBasis — combined presets', () => {
  it('scales to the combined preset target', () => {
    const basis: CalculationBasis = {
      kind: 'preset',
      selections: [{ presetId: 'p1', name: 'Individual portion', quantity: 45 }],
      extraGrams: 0,
      totalGrams: 2000,
    };
    expect(scaleForBasis(recipe, lines, basis)).toEqual({
      ok: true,
      factor: 2,
      scaledPortions: 8,
    });
  });
});

describe('scaledLines', () => {
  it('maps every quantity through the rounded scale', () => {
    expect(scaledLines(lines, 1.5).map((l) => l.quantity)).toEqual([900, 600]);
    // Rounds once at the 2-decimal canonical boundary.
    expect(scaledLines(lines, 1 / 3)[0]!.quantity).toBe(200);
  });

  it('preserves isSubRecipe and dimension', () => {
    const subRecipeLines: WorkbenchLine[] = [
      { id: 'c1', name: 'Almond paste', dimension: 'weight', quantity: 300, isSubRecipe: true },
    ];
    expect(scaledLines(subRecipeLines, 2)).toEqual([
      { id: 'c1', name: 'Almond paste', dimension: 'weight', quantity: 600, isSubRecipe: true },
    ]);
  });
});

describe('prepCardQueryFor', () => {
  it('is an empty query for the original (unscaled) basis', () => {
    expect(prepCardQueryFor({ kind: 'original' }, { ok: true, factor: 1, scaledPortions: 4 })).toBe('');
  });

  it('is null when the scale is invalid — callers must disable export', () => {
    const basis: CalculationBasis = { kind: 'weight', targetGrams: 500 };
    expect(prepCardQueryFor(basis, { ok: false, reason: 'invalid_yield' })).toBeNull();
  });

  it('builds a weight-basis query carrying factor + grams', () => {
    const basis: CalculationBasis = { kind: 'weight', targetGrams: 3500 };
    const query = prepCardQueryFor(basis, { ok: true, factor: 3.5, scaledPortions: 14 });
    const params = new URLSearchParams(query!.slice(1));
    expect(params.get('factor')).toBe('3.5');
    expect(params.get('basis')).toBe('weight');
    expect(params.get('grams')).toBe('3500');
  });

  it('builds a line-basis query carrying factor + lineId + target', () => {
    const basis: CalculationBasis = {
      kind: 'line',
      lineId: 'l1',
      lineName: 'Cream',
      targetCanonical: 900,
    };
    const query = prepCardQueryFor(basis, { ok: true, factor: 1.5, scaledPortions: 6 });
    const params = new URLSearchParams(query!.slice(1));
    expect(params.get('factor')).toBe('1.5');
    expect(params.get('basis')).toBe('line');
    expect(params.get('lineId')).toBe('l1');
    expect(params.get('target')).toBe('900');
  });

  it('builds a preset-basis query carrying factor + selections + extra', () => {
    const basis: CalculationBasis = {
      kind: 'preset',
      selections: [
        { presetId: 'p1', name: 'Individual portion', quantity: 45 },
        { presetId: 'p2', name: '18 cm cake', quantity: 4 },
      ],
      extraGrams: 100,
      totalGrams: 3902.5,
    };
    const query = prepCardQueryFor(basis, { ok: true, factor: 3.2521, scaledPortions: 13 });
    const params = new URLSearchParams(query!.slice(1));
    expect(params.get('basis')).toBe('preset');
    expect(params.get('sel')).toBe('p1:45,p2:4');
    expect(params.get('extra')).toBe('100');
  });

  it('omits extra when zero', () => {
    const basis: CalculationBasis = {
      kind: 'preset',
      selections: [{ presetId: 'p1', name: 'Individual portion', quantity: 45 }],
      extraGrams: 0,
      totalGrams: 2002.5,
    };
    const query = prepCardQueryFor(basis, { ok: true, factor: 2, scaledPortions: 8 });
    const params = new URLSearchParams(query!.slice(1));
    expect(params.has('extra')).toBe(false);
  });
});
