import { describe, expect, it } from 'vitest';
import { renderRecipeCardPdf } from './recipe-card-pdf';
import { buildRecipeCardLabels } from './recipe-card-labels';
import type { RecipeCardDocumentData } from './types';

/** Smoke test: the recipe card renderer produces real, non-empty PDF bytes. */
const labels = buildRecipeCardLabels((k) => k);

const data: RecipeCardDocumentData = {
  seller: { name: 'Padaria do Bairro', address: null, taxId: null, email: null, logoUrl: null },
  recipeName: 'Sourdough loaf',
  yieldPortions: 4,
  yieldPercentage: 90,
  scale: null,
  lines: [
    { name: 'Flour', dimension: 'weight', quantity: 1000, costCents: 120 },
    { name: 'Eggs', dimension: 'count', quantity: 3, costCents: 90 },
  ],
  ingredientCostCents: 233,
  laborCostCents: 500,
  energyCostCents: 120,
  packagingCostCents: 80,
  totalCostCents: 933,
  costPerPortionCents: 233,
  sellingPriceCents: 600,
  marginPercent: 61.2,
  notes: 'Proof overnight',
  currency: 'EUR',
};

describe('renderRecipeCardPdf', () => {
  it('returns non-empty PDF bytes', async () => {
    const buffer = await renderRecipeCardPdf(data, labels);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });

  it('renders without a selling price / margin', async () => {
    const buffer = await renderRecipeCardPdf(
      { ...data, sellingPriceCents: null, marginPercent: null },
      labels,
    );
    expect(buffer.length).toBeGreaterThan(0);
  });
});
