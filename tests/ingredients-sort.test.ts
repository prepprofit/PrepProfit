import { describe, expect, it } from 'vitest';
import {
  compareIngredients,
  DEFAULT_INGREDIENT_SORT,
  nextSort,
  type IngredientSort,
  type SortableIngredient,
} from '@/lib/ingredients/sort';

const rows: SortableIngredient[] = [
  { name: 'Butter', dimension: 'weight', priceCents: 900, needsPricing: false, supplier: 'metro', updatedAt: '2026-09-01' },
  { name: 'Eggs', dimension: 'count', priceCents: 25, needsPricing: false, supplier: null, updatedAt: '2026-09-10' },
  { name: 'Milk', dimension: 'volume', priceCents: 120, needsPricing: false, supplier: 'ARLA', updatedAt: '2026-08-01' },
  { name: 'almond flour', dimension: 'weight', priceCents: 1_800, needsPricing: false, supplier: 'MYLLÄRIN', updatedAt: '2026-09-05' },
  { name: 'Saffron', dimension: 'weight', priceCents: 0, needsPricing: true, supplier: 'Myllärin', updatedAt: '2026-07-01' },
  { name: 'Salt', dimension: 'weight', priceCents: 40, needsPricing: false, supplier: '  ', updatedAt: '2026-07-02' },
];

const order = (sort: IngredientSort, canSeeCosts = true) =>
  [...rows].sort((a, b) => compareIngredients(a, b, sort, canSeeCosts)).map((r) => r.name);

describe('ingredient column sorting', () => {
  it('opens attention-first (untrustworthy cost on top), then A→Z case-insensitively', () => {
    expect(order(DEFAULT_INGREDIENT_SORT)).toEqual(['Saffron', 'almond flour', 'Butter', 'Eggs', 'Milk', 'Salt']);
  });

  it('a chosen column gives no row a special position', () => {
    expect(order({ column: 'name', direction: 'asc' })).toEqual(['almond flour', 'Butter', 'Eggs', 'Milk', 'Saffron', 'Salt']);
    expect(order({ column: 'name', direction: 'desc' })).toEqual(['Salt', 'Saffron', 'Milk', 'Eggs', 'Butter', 'almond flour']);
  });

  it('sorts suppliers alphabetically, locale-aware and case-insensitive, unassigned last both ways', () => {
    // ARLA < metro < MYLLÄRIN = Myllärin (tie → ingredient name); blank/null last.
    expect(order({ column: 'supplier', direction: 'asc' })).toEqual(['Milk', 'Butter', 'almond flour', 'Saffron', 'Eggs', 'Salt']);
    expect(order({ column: 'supplier', direction: 'desc' })).toEqual(['almond flour', 'Saffron', 'Butter', 'Milk', 'Eggs', 'Salt']);
  });

  it('sorts by type both directions (piece, weight, volume), then name', () => {
    expect(order({ column: 'dimension', direction: 'asc' })).toEqual(['Eggs', 'almond flour', 'Butter', 'Saffron', 'Salt', 'Milk']);
    expect(order({ column: 'dimension', direction: 'desc' })).toEqual(['Milk', 'almond flour', 'Butter', 'Saffron', 'Salt', 'Eggs']);
  });

  it('sorts by price cheapest or most expensive first; kitchen falls back to name', () => {
    expect(order({ column: 'price', direction: 'asc' })).toEqual(['Saffron', 'Eggs', 'Salt', 'Milk', 'Butter', 'almond flour']);
    expect(order({ column: 'price', direction: 'desc' })).toEqual(['almond flour', 'Butter', 'Milk', 'Salt', 'Eggs', 'Saffron']);
    expect(order({ column: 'price', direction: 'desc' }, false)).toEqual(['almond flour', 'Butter', 'Eggs', 'Milk', 'Saffron', 'Salt']);
  });

  it('sorts by updated newest or oldest first', () => {
    expect(order({ column: 'updated', direction: 'desc' })).toEqual(['Eggs', 'almond flour', 'Butter', 'Milk', 'Salt', 'Saffron']);
    expect(order({ column: 'updated', direction: 'asc' })).toEqual(['Saffron', 'Salt', 'Milk', 'Butter', 'almond flour', 'Eggs']);
  });

  it('toggles a heading and starts new headings at their natural direction', () => {
    expect(nextSort(DEFAULT_INGREDIENT_SORT, 'name')).toEqual({ column: 'name', direction: 'desc' });
    expect(nextSort({ column: 'name', direction: 'desc' }, 'name')).toEqual({ column: 'name', direction: 'asc' });
    expect(nextSort(DEFAULT_INGREDIENT_SORT, 'updated')).toEqual({ column: 'updated', direction: 'desc' });
    expect(nextSort(DEFAULT_INGREDIENT_SORT, 'supplier')).toEqual({ column: 'supplier', direction: 'asc' });
  });
});
