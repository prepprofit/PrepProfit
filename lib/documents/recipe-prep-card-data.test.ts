import { describe, expect, it } from 'vitest';
import {
  buildRecipePrepCardData,
  recipePrepCardFilename,
} from './recipe-prep-card-data';
import { toKitchenRecipeWithIngredients } from '@/lib/data/recipes';
import type { Recipe } from '@/lib/db/schema';
import type { RecipeWithIngredients } from '@/lib/data/recipes';
import type { SellerSettings } from './seller';

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

const full: RecipeWithIngredients = {
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

const operational = toKitchenRecipeWithIngredients(full);

/** Money keys that must NEVER appear anywhere in a prep-card view-model. */
const MONEY_KEYS = [
  'cost',
  'costCents',
  'priceCents',
  'sellingPriceCents',
  'laborCostCents',
  'energyCostCents',
  'packagingCostCents',
  'totalCostCents',
  'costPerPortionCents',
  'marginPercent',
  'currency',
];

function assertMoneyFree(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertMoneyFree(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      expect(MONEY_KEYS, `${path}.${k} is a money key`).not.toContain(k);
      assertMoneyFree(v, `${path}.${k}`);
    }
  }
}

describe('buildRecipePrepCardData', () => {
  it('with no scale equals the current recipe quantities', () => {
    const card = buildRecipePrepCardData(operational, settings, null);
    expect(card.scale).toBeNull();
    expect(card.lines).toEqual([
      { name: 'Flour', dimension: 'weight', quantity: 1000 },
      { name: 'Eggs', dimension: 'count', quantity: 3 },
    ]);
    expect(card.yieldPortions).toBe(4);
  });

  it('scaling multiplies quantities and stamps the scaled portions', () => {
    const card = buildRecipePrepCardData(operational, settings, null, {
      ok: true,
      factor: 5,
      scaledPortions: 20,
    });
    expect(card.scale).toEqual({ factor: 5, scaledPortions: 20 });
    expect(card.lines[0]!.quantity).toBe(5000);
    expect(card.lines[1]!.quantity).toBe(15);
  });

  it('generated data has no money keys', () => {
    const card = buildRecipePrepCardData(operational, settings, null, {
      ok: true,
      factor: 2.5,
      scaledPortions: 10,
    });
    assertMoneyFree(card);
  });

  it('builds a sanitized filename stem', () => {
    expect(recipePrepCardFilename('Sourdough loaf')).toBe('prep-Sourdough loaf');
  });
});
