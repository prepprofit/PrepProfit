import { describe, expect, it } from 'vitest';
import { renderRecipePrepCardPdf } from './recipe-prep-card-pdf';
import { buildRecipePrepCardLabels } from './recipe-prep-card-labels';
import type { RecipePrepCardData } from './types';

/** Smoke test: the Kitchen Scale prep-card renderer produces real, non-empty PDF bytes. */
const labels = buildRecipePrepCardLabels((k) => k);

const data: RecipePrepCardData = {
  seller: { name: 'Padaria do Bairro', address: null, taxId: null, email: null, logoUrl: null },
  recipeName: 'Sourdough loaf',
  originalYieldPortions: 4,
  originalYieldWeightGrams: 1000,
  basis: { kind: 'original' },
  lines: [
    { name: 'Flour', dimension: 'weight', quantity: 1000, isSubRecipe: false },
    { name: 'Eggs', dimension: 'count', quantity: 3, isSubRecipe: false },
    { name: 'Pastry cream', dimension: 'weight', quantity: 250, isSubRecipe: true },
  ],
  totalWeightGrams: 1250,
  yieldPercentage: 90,
  expectedFinishedWeightGrams: 1125,
  method: [{ title: '', steps: ['Mix, then proof overnight.'] }],
  legacyNotes: null,
};

describe('renderRecipePrepCardPdf', () => {
  it('returns non-empty PDF bytes', async () => {
    const buffer = await renderRecipePrepCardPdf(data, labels);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });

  it('renders every calculation-basis kind without throwing', async () => {
    const bases: RecipePrepCardData['basis'][] = [
      { kind: 'original' },
      { kind: 'weight', grams: 3500 },
      { kind: 'line', lineName: 'Cream', amount: 900, dimension: 'weight' },
      {
        kind: 'preset',
        selections: [
          { name: 'Individual portion', quantity: 45 },
          { name: '18 cm cake', quantity: 4 },
        ],
        totalGrams: 3802.5,
      },
      { kind: 'factor', factor: 2.5 },
    ];
    for (const basis of bases) {
      const buffer = await renderRecipePrepCardPdf({ ...data, basis }, labels);
      expect(buffer.length).toBeGreaterThan(0);
    }
  });

  it('renders with legacy notes instead of structured steps', async () => {
    const buffer = await renderRecipePrepCardPdf(
      { ...data, method: [], legacyNotes: 'Proof overnight in the fridge.' },
      labels,
    );
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('renders with no preparation method at all (omits the section)', async () => {
    const buffer = await renderRecipePrepCardPdf({ ...data, method: [], legacyNotes: null }, labels);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('renders without a weight total (no weight-dimension lines)', async () => {
    const buffer = await renderRecipePrepCardPdf(
      {
        ...data,
        lines: [{ name: 'Eggs', dimension: 'count', quantity: 3, isSubRecipe: false }],
        totalWeightGrams: null,
        expectedFinishedWeightGrams: null,
      },
      labels,
    );
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('paginates a long recipe (many lines + steps) across A4 and LETTER', async () => {
    const manyLines = Array.from({ length: 60 }, (_, i) => ({
      name: `Ingredient ${i + 1}`,
      dimension: 'weight' as const,
      quantity: 100 + i,
      isSubRecipe: false,
    }));
    const manySteps = Array.from({ length: 40 }, (_, i) => `Step number ${i + 1}: do the thing.`);
    const long: RecipePrepCardData = {
      ...data,
      lines: manyLines,
      totalWeightGrams: manyLines.reduce((s, l) => s + l.quantity, 0),
      method: [{ title: '', steps: manySteps }],
    };
    for (const paper of ['A4', 'LETTER'] as const) {
      const buffer = await renderRecipePrepCardPdf(long, labels, paper);
      expect(buffer.length).toBeGreaterThan(0);
      expect(buffer.subarray(0, 4).toString('latin1')).toBe('%PDF');
    }
  });
});
