import { describe, it, expect } from 'vitest';
import {
  foodCostPercent,
  menuCost,
  mergeMenuAllergens,
  type MenuCostLine,
} from '@/lib/calculations/menu';
import type { RecipeAllergenRollup } from '@/lib/calculations/allergens';
import type { AllergenSlug, Presence } from '@/lib/allergens/catalog';

/**
 * Pure menu aggregation (Sprint 10). The whole point is the INCOMPLETE state: a
 * missing component never becomes a zero-cost line, and undefined KPIs are `null`
 * (never a misleading 0).
 */

const line = (
  recipeId: string,
  quantity: number,
  costPerPortionCents: number | null,
): MenuCostLine => ({ recipeId, quantity, costPerPortionCents });

describe('menuCost', () => {
  it('sums costPerPortionCents × quantity when every line is available', () => {
    const result = menuCost([line('a', 2, 150), line('b', 1, 300)]);
    expect(result).toEqual({
      complete: true,
      costCents: 600,
      unavailableRecipeIds: [],
    });
  });

  it('is incomplete (never zero) when a component is unavailable', () => {
    const result = menuCost([line('a', 2, 150), line('b', 1, null)]);
    expect(result.complete).toBe(false);
    expect(result.costCents).toBeNull();
    expect(result.complete === false && result.unavailableRecipeIds).toEqual(['b']);
  });

  it('lists every unavailable recipe id', () => {
    const result = menuCost([line('a', 1, null), line('b', 1, null)]);
    expect(result.complete === false && result.unavailableRecipeIds).toEqual([
      'a',
      'b',
    ]);
  });

  it('treats an empty line set as incomplete (a menu is never free)', () => {
    expect(menuCost([]).complete).toBe(false);
  });

  it('respects the portion quantity multiplier', () => {
    expect(menuCost([line('a', 3, 100)])).toMatchObject({ costCents: 300 });
  });

  it('rejects a non-integer / non-positive quantity defensively', () => {
    expect(menuCost([line('a', 0, 100)]).complete).toBe(false);
    expect(menuCost([line('a', 1.5, 100)]).complete).toBe(false);
  });

  it('is incomplete when the total overflows the safe-integer range', () => {
    const result = menuCost([line('a', 1000, Number.MAX_SAFE_INTEGER)]);
    expect(result.complete).toBe(false);
    expect(result.costCents).toBeNull();
  });
});

describe('foodCostPercent', () => {
  it('returns one-decimal cost / price × 100', () => {
    expect(foodCostPercent(300, 1000)).toBe(30);
    expect(foodCostPercent(333, 1000)).toBe(33.3);
  });

  it('returns null when the cost is unavailable', () => {
    expect(foodCostPercent(null, 1000)).toBeNull();
  });

  it('returns null when price is absent, zero, or negative', () => {
    expect(foodCostPercent(300, null)).toBeNull();
    expect(foodCostPercent(300, 0)).toBeNull();
    expect(foodCostPercent(300, -100)).toBeNull();
  });

  it('reports a real food-cost above 100% (underpriced menu)', () => {
    expect(foodCostPercent(1200, 1000)).toBe(120);
  });
});

describe('mergeMenuAllergens', () => {
  const rollup = (
    allergens: { allergen: AllergenSlug; effectivePresence: Presence }[],
    hasUnreviewedIngredient = false,
  ): RecipeAllergenRollup => ({
    allergens: allergens.map((a) => ({
      allergen: a.allergen,
      derivedPresence: a.effectivePresence,
      overridePresence: null,
      effectivePresence: a.effectivePresence,
    })),
    hasUnreviewedIngredient,
  });

  it('unions allergens keeping the strongest presence', () => {
    const merged = mergeMenuAllergens([
      rollup([{ allergen: 'milk', effectivePresence: 'may_contain' }]),
      rollup([{ allergen: 'milk', effectivePresence: 'contains' }]),
    ]);
    expect(merged.allergens).toEqual([{ allergen: 'milk', presence: 'contains' }]);
  });

  it('sorts by the fixed catalog order (eggs before milk)', () => {
    const merged = mergeMenuAllergens([
      rollup([{ allergen: 'milk', effectivePresence: 'contains' }]),
      rollup([{ allergen: 'eggs', effectivePresence: 'contains' }]),
    ]);
    expect(merged.allergens.map((a) => a.allergen)).toEqual(['eggs', 'milk']);
  });

  it('ORs the unreviewed flag across components', () => {
    expect(mergeMenuAllergens([rollup([], false), rollup([], true)])).toMatchObject({
      hasUnreviewedIngredient: true,
    });
    expect(mergeMenuAllergens([rollup([], false)])).toMatchObject({
      hasUnreviewedIngredient: false,
    });
  });
});
