import { describe, expect, it } from 'vitest';
import {
  compareIngredients,
  DEFAULT_INGREDIENT_SORT,
  nextSort,
  type IngredientSort,
  type SortableIngredient,
} from '@/lib/ingredients/sort';

const rows: SortableIngredient[] = [
  { name: 'Butter', dimension: 'weight', priceCents: 900, needsPricing: false, supplier: 'Makro', updatedAt: '2026-09-01' },
  { name: 'Eggs', dimension: 'count', priceCents: 25, needsPricing: false, supplier: null, updatedAt: '2026-09-10' },
  { name: 'Milk', dimension: 'volume', priceCents: 120, needsPricing: false, supplier: 'Dairy Co', updatedAt: '2026-08-01' },
  { name: 'Almond flour', dimension: 'weight', priceCents: 1_800, needsPricing: false, supplier: 'Makro', updatedAt: '2026-09-05' },
  { name: 'Saffron', dimension: 'weight', priceCents: 0, needsPricing: true, supplier: null, updatedAt: '2026-07-01' },
];

const order = (sort: IngredientSort, canSeeCosts = true) =>
  [...rows].sort((a, b) => compareIngredients(a, b, sort, canSeeCosts)).map((r) => r.name);

describe('ingredient column sorting', () => {
  it('sorts by name both ways, keeping untrustworthy costs pinned on top', () => {
    expect(order({ column: 'name', direction: 'asc' })).toEqual(['Saffron', 'Almond flour', 'Butter', 'Eggs', 'Milk']);
    expect(order({ column: 'name', direction: 'desc' })).toEqual(['Saffron', 'Milk', 'Eggs', 'Butter', 'Almond flour']);
  });

  it('groups by type: piece, weight, volume (then name)', () => {
    expect(order({ column: 'dimension', direction: 'asc' })).toEqual(['Saffron', 'Eggs', 'Almond flour', 'Butter', 'Milk']);
    expect(order({ column: 'dimension', direction: 'desc' })).toEqual(['Saffron', 'Milk', 'Almond flour', 'Butter', 'Eggs']);
  });

  it('sorts by price cheapest or most expensive first', () => {
    expect(order({ column: 'price', direction: 'asc' })).toEqual(['Saffron', 'Eggs', 'Milk', 'Butter', 'Almond flour']);
    expect(order({ column: 'price', direction: 'desc' })).toEqual(['Saffron', 'Almond flour', 'Butter', 'Milk', 'Eggs']);
  });

  it('ignores price for a kitchen viewer (no price key) and falls back to name', () => {
    expect(order({ column: 'price', direction: 'desc' }, false)).toEqual(['Saffron', 'Almond flour', 'Butter', 'Eggs', 'Milk']);
  });

  it('sorts by supplier with unsupplied ingredients last in both directions', () => {
    expect(order({ column: 'supplier', direction: 'asc' })).toEqual(['Saffron', 'Milk', 'Almond flour', 'Butter', 'Eggs']);
    expect(order({ column: 'supplier', direction: 'desc' })).toEqual(['Saffron', 'Almond flour', 'Butter', 'Milk', 'Eggs']);
  });

  it('sorts by updated newest or oldest first', () => {
    expect(order({ column: 'updated', direction: 'desc' })).toEqual(['Saffron', 'Eggs', 'Almond flour', 'Butter', 'Milk']);
    expect(order({ column: 'updated', direction: 'asc' })).toEqual(['Saffron', 'Milk', 'Butter', 'Almond flour', 'Eggs']);
  });

  it('toggles a heading and starts new headings at their natural direction', () => {
    expect(DEFAULT_INGREDIENT_SORT).toEqual({ column: 'name', direction: 'asc' });
    expect(nextSort(DEFAULT_INGREDIENT_SORT, 'name')).toEqual({ column: 'name', direction: 'desc' });
    expect(nextSort(DEFAULT_INGREDIENT_SORT, 'updated')).toEqual({ column: 'updated', direction: 'desc' });
    expect(nextSort(DEFAULT_INGREDIENT_SORT, 'price')).toEqual({ column: 'price', direction: 'asc' });
  });
});
