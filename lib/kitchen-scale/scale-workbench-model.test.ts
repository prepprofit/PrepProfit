import { describe, expect, it } from 'vitest';
import {
  RECIPE_SCALE_PORTIONS_MAX,
  parseScaleParam,
} from '@/lib/validation/recipe-scale';
import {
  basketTargetGrams,
  portionsParamFor,
  scaleFromAnchor,
  scaleFromBasket,
  scaledLines,
  type WorkbenchLine,
  type WorkbenchRecipe,
} from './scale-workbench-model';

const recipe: WorkbenchRecipe = { yieldPortions: 4, yieldWeightGrams: 1000 };

const lines: WorkbenchLine[] = [
  { id: 'l1', ingredientId: 'i1', name: 'Flour', dimension: 'weight', quantity: 600 },
  { id: 'l2', ingredientId: 'i2', name: 'Water', dimension: 'volume', quantity: 400 },
];

describe('kitchen scale workbench model', () => {
  it('sums a preset basket: 2 × 500g + 1 × 300g = 1300g', () => {
    expect(
      basketTargetGrams({
        presetQuantities: [
          { targetWeightGrams: 500, quantity: 2 },
          { targetWeightGrams: 300, quantity: 1 },
        ],
        customWeightGrams: 0,
      }),
    ).toBe(1300);
  });

  it('custom weight only, and basket plus custom weight', () => {
    expect(
      basketTargetGrams({ presetQuantities: [], customWeightGrams: 750 }),
    ).toBe(750);
    expect(
      basketTargetGrams({
        presetQuantities: [{ targetWeightGrams: 500, quantity: 1 }],
        customWeightGrams: 250,
      }),
    ).toBe(750);
  });

  it('yield-weight scale gives factor = target / yieldWeightGrams', () => {
    const result = scaleFromBasket(recipe, lines, {
      presetQuantities: [],
      customWeightGrams: 2000,
    });
    expect(result).toEqual({ ok: true, factor: 2, scaledPortions: 8 });
  });

  it('recipe without a yield weight cannot scale by weight (invalid_yield)', () => {
    const result = scaleFromBasket(
      { yieldPortions: 4, yieldWeightGrams: null },
      lines,
      { presetQuantities: [], customWeightGrams: 500 },
    );
    expect(result).toEqual({ ok: false, reason: 'invalid_yield' });
  });

  it('anchor edit recalculates factor from the edited ingredient quantity', () => {
    // Flour 600g edited to 900g → factor 1.5, portions 6.
    const result = scaleFromAnchor(recipe, lines, 'l1', 900);
    expect(result).toEqual({ ok: true, factor: 1.5, scaledPortions: 6 });
    // Unknown line id is an anchor error, never a crash.
    expect(scaleFromAnchor(recipe, lines, 'missing', 900)).toEqual({
      ok: false,
      reason: 'invalid_anchor',
    });
  });

  it('scaledLines maps every quantity through the rounded scale', () => {
    expect(scaledLines(lines, 1.5).map((l) => l.quantity)).toEqual([900, 600]);
    // Rounds once at the 2-decimal canonical boundary.
    expect(scaledLines(lines, 1 / 3)[0]!.quantity).toBe(200);
  });

  it('invalid/zero input yields no exportable portions param', () => {
    expect(
      portionsParamFor(
        scaleFromBasket(recipe, lines, { presetQuantities: [], customWeightGrams: 0 }),
      ),
    ).toBeNull();
    expect(
      portionsParamFor(scaleFromAnchor(recipe, lines, 'l1', Number.NaN)),
    ).toBeNull();
  });

  it('overflow reason propagates from deriveScale', () => {
    const result = scaleFromAnchor(recipe, lines, 'l1', 6e10);
    expect(result).toEqual({ ok: false, reason: 'overflow' });
    expect(portionsParamFor(result)).toBeNull();
  });

  it('portions param obeys the existing max and 4-decimal precision', () => {
    // A fractional factor produces a ≤ 4-decimal param the server accepts.
    const third = scaleFromAnchor(recipe, lines, 'l1', 200); // factor 1/3
    const param = portionsParamFor(third);
    expect(param).toBe('1.3333');
    expect(parseScaleParam(param)).toEqual({ ok: true, portions: 1.3333 });

    // Beyond the shared cap the param is refused even when the scale itself is
    // ok (tiny line quantities keep the overflow guard quiet): the PDF route
    // would 400 on such a value.
    const tinyLines: WorkbenchLine[] = [
      { id: 'l1', ingredientId: 'i1', name: 'Salt', dimension: 'weight', quantity: 1 },
    ];
    const huge = scaleFromBasket(recipe, tinyLines, {
      presetQuantities: [],
      // factor 5e5 → 2,000,000 portions (over the 1,000,000 cap) while the
      // single 1g line stays far below the quantity overflow guard.
      customWeightGrams: 5e8,
    });
    expect(
      (huge.ok ? huge.scaledPortions : 0) > RECIPE_SCALE_PORTIONS_MAX,
    ).toBe(true);
    expect(huge.ok).toBe(true);
    expect(portionsParamFor(huge)).toBeNull();
  });
});
