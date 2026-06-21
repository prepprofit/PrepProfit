import { describe, expect, it } from 'vitest';
import {
  ALLERGEN_CATALOG,
  ALLERGEN_ORDER,
  ALLERGEN_SLUGS,
  PRESENCE_ORDER,
  PRESENCE_VALUES,
  isAllergenSlug,
  isPresence,
} from './catalog';

describe('allergen catalog', () => {
  it('has exactly the 14 EU FIC allergens', () => {
    expect(ALLERGEN_CATALOG).toHaveLength(14);
    expect(ALLERGEN_SLUGS).toHaveLength(14);
  });

  it('lists every required EU FIC slug', () => {
    expect(new Set(ALLERGEN_SLUGS)).toEqual(
      new Set([
        'cereals_gluten',
        'crustaceans',
        'eggs',
        'fish',
        'peanuts',
        'soybeans',
        'milk',
        'nuts',
        'celery',
        'mustard',
        'sesame',
        'sulphites',
        'lupin',
        'molluscs',
      ]),
    );
  });

  it('has no duplicate slugs', () => {
    expect(new Set(ALLERGEN_SLUGS).size).toBe(ALLERGEN_SLUGS.length);
  });

  it('gives every slug a non-empty operational label', () => {
    for (const entry of ALLERGEN_CATALOG) {
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it('orders slugs by their catalog index', () => {
    ALLERGEN_CATALOG.forEach((entry, index) => {
      expect(ALLERGEN_ORDER[entry.slug]).toBe(index);
    });
  });
});

describe('presence levels', () => {
  it('ranks contains above may_contain', () => {
    expect(PRESENCE_ORDER.contains).toBeGreaterThan(PRESENCE_ORDER.may_contain);
  });

  it('lists both presence values weakest-first', () => {
    expect(PRESENCE_VALUES).toEqual(['may_contain', 'contains']);
  });
});

describe('type guards', () => {
  it('accepts catalog slugs and rejects others', () => {
    expect(isAllergenSlug('milk')).toBe(true);
    expect(isAllergenSlug('gluten')).toBe(false);
    expect(isAllergenSlug('')).toBe(false);
  });

  it('accepts presence values and rejects others', () => {
    expect(isPresence('contains')).toBe(true);
    expect(isPresence('may_contain')).toBe(true);
    expect(isPresence('definitely')).toBe(false);
    expect(isPresence('severity')).toBe(false);
  });
});
