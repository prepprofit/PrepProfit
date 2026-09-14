import { describe, it, expect } from 'vitest';
import { mergeMenuAllergens } from '@/lib/calculations/menu';
import type { RecipeAllergenRollup } from '@/lib/calculations/allergens';
import type { AllergenSlug, Presence } from '@/lib/allergens/catalog';

/** Dish allergen rollup: strongest presence wins; unreviewed is an OR; never "allergen-free". */

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
