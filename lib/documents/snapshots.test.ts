import { describe, expect, it } from 'vitest';
import {
  ingredientLineSnapshot,
  recipeLineSnapshot,
} from './snapshots';

describe('ingredientLineSnapshot', () => {
  it('freezes name, cost and dimension from the master', () => {
    expect(
      ingredientLineSnapshot({
        name: 'Flour',
        priceCents: 12000,
        dimension: 'weight',
      }),
    ).toEqual({
      ingredientName: 'Flour',
      unitCostCents: 12000,
      dimension: 'weight',
    });
  });

  it('maps priceCents → unitCostCents (cost, not selling price)', () => {
    const snap = ingredientLineSnapshot({
      name: 'Olive oil',
      priceCents: 899,
      dimension: 'volume',
    });
    expect(snap.unitCostCents).toBe(899);
    expect('unitPriceCents' in snap).toBe(false);
  });

  it('carries each dimension verbatim', () => {
    expect(
      ingredientLineSnapshot({ name: 'Eggs', priceCents: 30, dimension: 'count' })
        .dimension,
    ).toBe('count');
    expect(
      ingredientLineSnapshot({ name: 'Milk', priceCents: 110, dimension: 'volume' })
        .dimension,
    ).toBe('volume');
  });

  it('preserves an unpriced (zero) cost without inventing a value', () => {
    expect(
      ingredientLineSnapshot({ name: 'Salt', priceCents: 0, dimension: 'weight' })
        .unitCostCents,
    ).toBe(0);
  });

  it('keeps large integer-cent values exactly', () => {
    expect(
      ingredientLineSnapshot({
        name: 'Saffron',
        priceCents: 2_147_483_647,
        dimension: 'weight',
      }).unitCostCents,
    ).toBe(2_147_483_647);
  });

  it('does not read the live row — only the picked fields are snapshotted', () => {
    // A snapshot built from a narrow Pick must not depend on any other column.
    const picked = { name: 'Butter', priceCents: 540, dimension: 'weight' } as const;
    expect(ingredientLineSnapshot(picked)).toEqual({
      ingredientName: 'Butter',
      unitCostCents: 540,
      dimension: 'weight',
    });
  });
});

describe('recipeLineSnapshot', () => {
  it('freezes the recipe name and the supplied portion cost', () => {
    expect(recipeLineSnapshot({ name: 'Sourdough loaf' }, 320)).toEqual({
      recipeName: 'Sourdough loaf',
      portionCostCents: 320,
    });
  });

  it('stores ONLY the single portionCostCents the document used at capture', () => {
    const snap = recipeLineSnapshot({ name: 'Croissant' }, 145);
    expect(Object.keys(snap).sort()).toEqual(['portionCostCents', 'recipeName']);
  });

  it('keeps a zero portion cost as-is', () => {
    expect(recipeLineSnapshot({ name: 'Free sample' }, 0).portionCostCents).toBe(0);
  });

  it('keeps large integer-cent portion costs exactly', () => {
    expect(
      recipeLineSnapshot({ name: 'Wedding cake' }, 2_147_483_647).portionCostCents,
    ).toBe(2_147_483_647);
  });
});
