import { describe, expect, it } from 'vitest';
import type { RecipeAllergenSummary } from '@/lib/data/allergens';
import { buildAllergenMatrixData } from './allergen-matrix-data';
import { buildAllergenMatrixRows } from './allergen-matrix-xlsx';
import type { AllergenMatrixLabels } from './types';

const SETTINGS = {
  currency: 'EUR',
  businessName: 'Test Bakery',
  businessAddress: null,
  businessTaxId: null,
  businessEmail: null,
  businessLogoUrl: null,
};

const summaries: RecipeAllergenSummary[] = [
  {
    recipeId: 'r1',
    recipeName: 'Cake',
    rollup: {
      allergens: [
        { allergen: 'cereals_gluten', derivedPresence: 'contains', overridePresence: null, effectivePresence: 'contains' },
        { allergen: 'milk', derivedPresence: 'may_contain', overridePresence: 'contains', effectivePresence: 'contains' },
      ],
      hasUnreviewedIngredient: false,
    },
  },
  {
    recipeId: 'r2',
    recipeName: 'Bread',
    rollup: {
      allergens: [
        { allergen: 'cereals_gluten', derivedPresence: 'contains', overridePresence: null, effectivePresence: 'contains' },
      ],
      hasUnreviewedIngredient: true,
    },
  },
];

const labels: AllergenMatrixLabels = {
  title: 'ALLERGEN MATRIX',
  generatedOn: 'Generated',
  recipe: 'Recipe',
  disclaimer: 'Not a legal declaration.',
  noAllergensRecorded: 'No allergens recorded.',
  presence: { contains: 'Contains', may_contain: 'May contain' },
  unreviewed: 'unreviewed',
  allergenLabels: {
    cereals_gluten: 'Cereals containing gluten',
    crustaceans: 'Crustaceans',
    eggs: 'Eggs',
    fish: 'Fish',
    peanuts: 'Peanuts',
    soybeans: 'Soybeans',
    milk: 'Milk',
    nuts: 'Tree nuts',
    celery: 'Celery',
    mustard: 'Mustard',
    sesame: 'Sesame',
    sulphites: 'Sulphur dioxide and sulphites',
    lupin: 'Lupin',
    molluscs: 'Molluscs',
  },
};

describe('buildAllergenMatrixData', () => {
  it('columns are the present allergens in catalog order', () => {
    const data = buildAllergenMatrixData(summaries, SETTINGS, null, '2026-06-21');
    // cereals_gluten (0) before milk (6).
    expect(data.allergens).toEqual(['cereals_gluten', 'milk']);
    expect(data.rows.map((r) => r.recipeName)).toEqual(['Cake', 'Bread']);
  });

  it('cells carry the EFFECTIVE presence per recipe', () => {
    const data = buildAllergenMatrixData(summaries, SETTINGS, null, '2026-06-21');
    const cake = data.rows.find((r) => r.recipeName === 'Cake')!;
    expect(cake.cells.milk).toBe('contains');
    const bread = data.rows.find((r) => r.recipeName === 'Bread')!;
    expect(bread.cells.milk).toBeUndefined();
    expect(bread.hasUnreviewedIngredient).toBe(true);
  });

  it('empty org → no allergen columns', () => {
    const data = buildAllergenMatrixData([], SETTINGS, null, '2026-06-21');
    expect(data.allergens).toEqual([]);
    expect(data.rows).toEqual([]);
  });

  it('carries NO monetary key anywhere in the view-model', () => {
    const data = buildAllergenMatrixData(summaries, SETTINGS, null, '2026-06-21');
    const json = JSON.stringify(data);
    expect(json.toLowerCase()).not.toContain('cents');
    expect(json.toLowerCase()).not.toContain('price');
    expect(json.toLowerCase()).not.toContain('cost');
  });
});

describe('buildAllergenMatrixRows (XLSX)', () => {
  it('renders only text/empty cells — NO money Number cells', () => {
    const data = buildAllergenMatrixData(summaries, SETTINGS, null, '2026-06-21');
    const rows = buildAllergenMatrixRows(data, labels);
    for (const row of rows) {
      for (const cell of row) {
        if ('type' in cell && cell.type === Number) {
          throw new Error('Allergen matrix must never contain a Number/money cell');
        }
      }
    }
  });

  it('marks an unreviewed recipe in its row label', () => {
    const data = buildAllergenMatrixData(summaries, SETTINGS, null, '2026-06-21');
    const rows = buildAllergenMatrixRows(data, labels);
    const flat = JSON.stringify(rows);
    expect(flat).toContain('Bread (unreviewed)');
    // Never the phrase "allergen-free".
    expect(flat.toLowerCase()).not.toContain('allergen-free');
  });
});
