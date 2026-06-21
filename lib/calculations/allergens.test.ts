import { describe, expect, it } from 'vitest';
import {
  comparePresence,
  maxPresence,
  recipeAllergens,
  type AllergenLine,
  type AllergenOverride,
} from './allergens';

const reviewed = (
  allergens: AllergenLine['allergens'],
): AllergenLine => ({ reviewed: true, allergens });

describe('comparePresence / maxPresence', () => {
  it('ranks contains above may_contain', () => {
    expect(comparePresence('contains', 'may_contain')).toBeGreaterThan(0);
    expect(comparePresence('may_contain', 'contains')).toBeLessThan(0);
    expect(comparePresence('contains', 'contains')).toBe(0);
  });

  it('takes the stronger presence', () => {
    expect(maxPresence('may_contain', 'contains')).toBe('contains');
    expect(maxPresence('contains', 'may_contain')).toBe('contains');
    expect(maxPresence('may_contain', 'may_contain')).toBe('may_contain');
  });
});

describe('recipeAllergens', () => {
  it('returns empty for a recipe with no allergens', () => {
    const rollup = recipeAllergens([reviewed([])], []);
    expect(rollup.allergens).toEqual([]);
    expect(rollup.hasUnreviewedIngredient).toBe(false);
  });

  it('unions allergens across lines and takes the strongest derived presence', () => {
    const lines: AllergenLine[] = [
      reviewed([{ allergen: 'milk', presence: 'may_contain' }]),
      reviewed([
        { allergen: 'milk', presence: 'contains' },
        { allergen: 'eggs', presence: 'contains' },
      ]),
    ];
    const rollup = recipeAllergens(lines, []);
    const milk = rollup.allergens.find((a) => a.allergen === 'milk');
    expect(milk?.derivedPresence).toBe('contains');
    expect(milk?.effectivePresence).toBe('contains');
    expect(rollup.allergens.map((a) => a.allergen)).toContain('eggs');
  });

  it('an override ADDS a brand-new allergen', () => {
    const rollup = recipeAllergens(
      [reviewed([{ allergen: 'milk', presence: 'contains' }])],
      [{ allergen: 'nuts', presence: 'may_contain' }],
    );
    const nuts = rollup.allergens.find((a) => a.allergen === 'nuts');
    expect(nuts?.derivedPresence).toBeNull();
    expect(nuts?.overridePresence).toBe('may_contain');
    expect(nuts?.effectivePresence).toBe('may_contain');
  });

  it('an override ESCALATES may_contain → contains', () => {
    const rollup = recipeAllergens(
      [reviewed([{ allergen: 'milk', presence: 'may_contain' }])],
      [{ allergen: 'milk', presence: 'contains' }],
    );
    const milk = rollup.allergens.find((a) => a.allergen === 'milk');
    expect(milk?.derivedPresence).toBe('may_contain');
    expect(milk?.overridePresence).toBe('contains');
    expect(milk?.effectivePresence).toBe('contains');
  });

  it('returns derived and override separately (never a single source)', () => {
    const rollup = recipeAllergens(
      [reviewed([{ allergen: 'milk', presence: 'may_contain' }])],
      [{ allergen: 'milk', presence: 'contains' }],
    );
    const milk = rollup.allergens.find((a) => a.allergen === 'milk');
    expect(milk).toMatchObject({
      derivedPresence: 'may_contain',
      overridePresence: 'contains',
    });
  });

  it('INVARIANT: effective is never below derived (override cannot lower)', () => {
    // A (hypothetical) weaker override must not drag effective below derived.
    const rollup = recipeAllergens(
      [reviewed([{ allergen: 'milk', presence: 'contains' }])],
      [{ allergen: 'milk', presence: 'may_contain' }],
    );
    const milk = rollup.allergens.find((a) => a.allergen === 'milk');
    expect(milk?.derivedPresence).toBe('contains');
    expect(milk?.effectivePresence).toBe('contains');
  });

  it('clearing an override never hides the derived allergen', () => {
    const withOverride = recipeAllergens(
      [reviewed([{ allergen: 'milk', presence: 'contains' }])],
      [{ allergen: 'milk', presence: 'contains' }],
    );
    const cleared = recipeAllergens(
      [reviewed([{ allergen: 'milk', presence: 'contains' }])],
      [],
    );
    expect(withOverride.allergens.find((a) => a.allergen === 'milk')?.effectivePresence).toBe(
      'contains',
    );
    // After clearing, the derived allergen still shows (max(derived, ∅) = derived).
    const milk = cleared.allergens.find((a) => a.allergen === 'milk');
    expect(milk?.overridePresence).toBeNull();
    expect(milk?.effectivePresence).toBe('contains');
  });

  it('sorts results by the fixed catalog order', () => {
    const lines: AllergenLine[] = [
      reviewed([
        { allergen: 'molluscs', presence: 'contains' }, // catalog index 13
        { allergen: 'eggs', presence: 'contains' }, // index 2
        { allergen: 'cereals_gluten', presence: 'contains' }, // index 0
      ]),
    ];
    const rollup = recipeAllergens(lines, []);
    expect(rollup.allergens.map((a) => a.allergen)).toEqual([
      'cereals_gluten',
      'eggs',
      'molluscs',
    ]);
  });

  it('flags hasUnreviewedIngredient when a line is unreviewed', () => {
    const lines: AllergenLine[] = [
      reviewed([{ allergen: 'milk', presence: 'contains' }]),
      { reviewed: false, allergens: [] },
    ];
    expect(recipeAllergens(lines, []).hasUnreviewedIngredient).toBe(true);
  });

  it('includes a trashed ingredient line (caller passes it like any other)', () => {
    // The rollup itself is agnostic to deleted_at — it trusts the caller to pass
    // every referenced line (the data layer does NOT filter deleted_at). This pins
    // that such an extra line contributes normally; catalog order is peanuts(4)
    // before milk(6).
    const lines: AllergenLine[] = [
      reviewed([{ allergen: 'milk', presence: 'contains' }]),
      reviewed([{ allergen: 'peanuts', presence: 'contains' }]),
    ];
    const overrides: AllergenOverride[] = [];
    expect(recipeAllergens(lines, overrides).allergens.map((a) => a.allergen)).toEqual([
      'peanuts',
      'milk',
    ]);
  });
});
