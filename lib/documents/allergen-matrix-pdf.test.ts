import { describe, expect, it } from 'vitest';
import { renderAllergenMatrixPdf } from './allergen-matrix-pdf';
import type { AllergenMatrixData, AllergenMatrixLabels } from './types';

/** Smoke test: the allergen matrix renderer produces real, non-empty PDF bytes. */
const labels: AllergenMatrixLabels = {
  title: 'ALLERGEN MATRIX',
  generatedOn: 'Generated',
  recipe: 'Recipe',
  disclaimer: 'Operational aid — not a legal declaration.',
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

const data: AllergenMatrixData = {
  seller: { name: 'Padaria do Bairro', address: null, taxId: null, email: null, logoUrl: null },
  allergens: ['cereals_gluten', 'milk'],
  rows: [
    {
      recipeName: 'Cake',
      cells: { cereals_gluten: 'contains', milk: 'may_contain' },
      hasUnreviewedIngredient: true,
    },
  ],
  generatedOn: '2026-06-21',
};

describe('renderAllergenMatrixPdf', () => {
  it('returns non-empty PDF bytes', async () => {
    const buffer = await renderAllergenMatrixPdf(data, labels);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });

  it('renders the empty state (no allergens recorded)', async () => {
    const buffer = await renderAllergenMatrixPdf(
      { ...data, allergens: [], rows: [] },
      labels,
    );
    expect(buffer.length).toBeGreaterThan(0);
  });
});
