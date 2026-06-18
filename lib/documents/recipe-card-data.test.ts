import { describe, expect, it } from 'vitest';
import { buildRecipeCardData, recipeCardFilename } from './recipe-card-data';
import { recipeCost, lineCostCents } from '@/lib/calculations/recipeCost';
import { marginPercent } from '@/lib/calculations/margin';
import type { Recipe } from '@/lib/db/schema';
import type { RecipeWithIngredients } from '@/lib/data/recipes';
import type { SellerSettings } from './seller';

/**
 * The recipe card view-model must reconcile with the SAME cost + margin calcs the
 * recipe editor uses — no parallel arithmetic.
 */

const settings: SellerSettings = {
  currency: 'EUR',
  businessName: 'Padaria do Bairro',
  businessAddress: null,
  businessTaxId: null,
  businessEmail: null,
  businessLogoUrl: null,
};

function makeRecipe(over: Partial<Recipe> = {}): Recipe {
  return {
    id: 'rec_1',
    organizationId: 'org_a',
    name: 'Sourdough loaf',
    folderId: null,
    yieldPortions: 4,
    yieldPercentage: 90,
    laborCostCents: 500,
    energyCostCents: 120,
    packagingCostCents: 80,
    sellingPriceCents: 600,
    notes: 'Proof overnight',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...over,
  } as Recipe;
}

const data: RecipeWithIngredients = {
  recipe: makeRecipe(),
  lines: [
    {
      id: 'l1',
      ingredientId: 'i1',
      quantity: 1000,
      sortOrder: 0,
      ingredient: { name: 'Flour', dimension: 'weight', priceCents: 120 },
    },
    {
      id: 'l2',
      ingredientId: 'i2',
      quantity: 3,
      sortOrder: 1,
      ingredient: { name: 'Eggs', dimension: 'count', priceCents: 30 },
    },
  ],
};

describe('buildRecipeCardData', () => {
  it('reconciles totals and per-line costs with recipeCost/lineCostCents', () => {
    const card = buildRecipeCardData(data, settings, null);

    const expected = recipeCost({
      yieldPortions: 4,
      yieldPercentage: 90,
      laborCostCents: 500,
      energyCostCents: 120,
      packagingCostCents: 80,
      lines: [
        { dimension: 'weight', priceCents: 120, quantity: 1000 },
        { dimension: 'count', priceCents: 30, quantity: 3 },
      ],
    });

    expect(card.ingredientCostCents).toBe(expected.ingredientCostCents);
    expect(card.totalCostCents).toBe(expected.totalCostCents);
    expect(card.costPerPortionCents).toBe(expected.costPerPortionCents);

    expect(card.lines[0]!.costCents).toBe(
      Math.round(lineCostCents({ dimension: 'weight', priceCents: 120, quantity: 1000 })),
    );
    expect(card.lines[1]!.costCents).toBe(
      Math.round(lineCostCents({ dimension: 'count', priceCents: 30, quantity: 3 })),
    );
  });

  it('reconciles margin with marginPercent (cost per portion vs selling price)', () => {
    const card = buildRecipeCardData(data, settings, null);
    expect(card.marginPercent).toBe(
      marginPercent(card.costPerPortionCents, 600),
    );
  });

  it('returns a null margin when no selling price is set', () => {
    const card = buildRecipeCardData(
      { ...data, recipe: makeRecipe({ sellingPriceCents: null }) },
      settings,
      null,
    );
    expect(card.sellingPriceCents).toBeNull();
    expect(card.marginPercent).toBeNull();
  });

  it('falls back to the Clerk org name when businessName is blank', () => {
    const card = buildRecipeCardData(
      data,
      { ...settings, businessName: null },
      'Acme Bakery',
    );
    expect(card.seller.name).toBe('Acme Bakery');
  });

  it('builds a sanitized filename stem', () => {
    expect(recipeCardFilename('Sourdough loaf')).toBe('recipe-Sourdough loaf');
  });
});
