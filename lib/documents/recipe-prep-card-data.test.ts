import { describe, expect, it } from 'vitest';
import {
  basisCaption,
  buildRecipePrepCardData,
  recipePrepCardFilename,
  resolvePrepCardBasis,
  type PrepCardPreset,
} from './recipe-prep-card-data';
import type { KitchenScaleRecipeDocument } from '@/lib/kitchen-scale/prep-document';
import type { RecipePrepCardLabels } from './types';
import type { SellerSettings } from './seller';

const labels: RecipePrepCardLabels = {
  brand: (b) => (b ? `PrepProfit · ${b}` : 'PrepProfit'),
  basisOriginal: 'Original recipe / ×1',
  basisWeight: (amount) => `Target weight: ${amount}`,
  basisLine: ({ name, amount }) => `Based on ${name}: ${amount}`,
  basisPreset: ({ summary, total }) => `${summary} — total ${total}`,
  presetItem: ({ quantity, name }) => `${quantity} × ${name}`,
  basisFactor: (factor) => `Scaled ×${factor}`,
  ingredient: 'Ingredient',
  quantity: 'Qty',
  subRecipe: '(sub-recipe)',
  totalToWeigh: 'Total to weigh',
  expectedFinishedWeight: 'Expected finished weight',
  method: 'Preparation',
  footer: (recipeName) => recipeName,
  units: { weight: 'g', volume: 'ml', count: '×' },
};

const settings: SellerSettings = {
  currency: 'EUR',
  businessName: 'Padaria do Bairro',
  businessAddress: null,
  businessTaxId: null,
  businessEmail: null,
  businessLogoUrl: null,
};

function makeDoc(over: Partial<KitchenScaleRecipeDocument> = {}): KitchenScaleRecipeDocument {
  return {
    id: 'rec_1',
    name: 'Sourdough loaf',
    yieldPortions: 4,
    yieldWeightGrams: 1000,
    yieldPercentage: 90,
    lines: [
      { id: 'l1', name: 'Flour', dimension: 'weight', quantity: 1000, isSubRecipe: false },
      { id: 'l2', name: 'Eggs', dimension: 'count', quantity: 3, isSubRecipe: false },
    ],
    method: [],
    legacyNotes: null,
    ...over,
  };
}

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
  it('with factor 1 and no basis param, equals the original recipe', () => {
    const card = buildRecipePrepCardData(makeDoc(), settings, null, 1, null, []);
    expect(card.basis).toEqual({ kind: 'original' });
    expect(card.lines).toEqual([
      { name: 'Flour', dimension: 'weight', quantity: 1000, isSubRecipe: false },
      { name: 'Eggs', dimension: 'count', quantity: 3, isSubRecipe: false },
    ]);
    expect(card.originalYieldPortions).toBe(4);
  });

  it('scaling multiplies every line quantity by the applied factor', () => {
    const card = buildRecipePrepCardData(makeDoc(), settings, null, 5, null, []);
    expect(card.lines[0]!.quantity).toBe(5000);
    expect(card.lines[1]!.quantity).toBe(15);
  });

  it('sums only weight-dimension lines into totalWeightGrams', () => {
    const doc = makeDoc({
      lines: [
        { id: 'l1', name: 'Butter', dimension: 'weight', quantity: 500, isSubRecipe: false },
        { id: 'l2', name: 'Milk', dimension: 'volume', quantity: 300, isSubRecipe: false },
        { id: 'l3', name: 'Eggs', dimension: 'count', quantity: 3, isSubRecipe: false },
      ],
    });
    const card = buildRecipePrepCardData(doc, settings, null, 1, null, []);
    expect(card.totalWeightGrams).toBe(500);
  });

  it('is null when the recipe has no weight-dimension lines', () => {
    const doc = makeDoc({
      lines: [{ id: 'l1', name: 'Milk', dimension: 'volume', quantity: 300, isSubRecipe: false }],
    });
    const card = buildRecipePrepCardData(doc, settings, null, 1, null, []);
    expect(card.totalWeightGrams).toBeNull();
  });

  it('computes expected finished weight only when yield loss applies', () => {
    const withLoss = buildRecipePrepCardData(
      makeDoc({ yieldPercentage: 90 }),
      settings,
      null,
      1,
      null,
      [],
    );
    expect(withLoss.expectedFinishedWeightGrams).toBe(900);

    const noLoss = buildRecipePrepCardData(
      makeDoc({ yieldPercentage: 100 }),
      settings,
      null,
      1,
      null,
      [],
    );
    expect(noLoss.expectedFinishedWeightGrams).toBeNull();
  });

  it('generated data has no money keys', () => {
    const card = buildRecipePrepCardData(makeDoc(), settings, null, 2.5, null, []);
    assertMoneyFree(card);
  });

  it('builds a sanitized filename stem', () => {
    expect(recipePrepCardFilename('Sourdough loaf')).toBe('prep-Sourdough loaf');
  });
});

describe('resolvePrepCardBasis', () => {
  const lines = [
    { id: 'l1', name: 'Cream', dimension: 'weight' as const },
    { id: 'l2', name: 'Sugar', dimension: 'weight' as const },
  ];
  const presets: PrepCardPreset[] = [
    { id: 'p1', name: 'Individual portion', targetWeightGrams: 44.5 },
    { id: 'p2', name: '18 cm cake', targetWeightGrams: 450 },
  ];

  it('is "original" at factor 1 with no basis param', () => {
    expect(resolvePrepCardBasis(1, null, lines, presets)).toEqual({ kind: 'original' });
  });

  it('falls back to a generic factor caption when scaled with no basis param', () => {
    expect(resolvePrepCardBasis(2, null, lines, presets)).toEqual({ kind: 'factor', factor: 2 });
  });

  it('resolves a weight basis', () => {
    expect(
      resolvePrepCardBasis(3.5, { kind: 'weight', grams: 3500 }, lines, presets),
    ).toEqual({ kind: 'weight', grams: 3500 });
  });

  it('resolves a line basis to the current line name + dimension', () => {
    expect(
      resolvePrepCardBasis(1.5, { kind: 'line', lineId: 'l1', target: 900 }, lines, presets),
    ).toEqual({ kind: 'line', lineName: 'Cream', amount: 900, dimension: 'weight' });
  });

  it('falls back to factor when the anchor line id no longer exists', () => {
    expect(
      resolvePrepCardBasis(1.5, { kind: 'line', lineId: 'gone', target: 900 }, lines, presets),
    ).toEqual({ kind: 'factor', factor: 1.5 });
  });

  it('resolves a combined-presets basis with names + computed total', () => {
    const result = resolvePrepCardBasis(
      3.2521,
      {
        kind: 'preset',
        selections: [
          { presetId: 'p1', quantity: 45 },
          { presetId: 'p2', quantity: 4 },
        ],
        extraGrams: 0,
      },
      lines,
      presets,
    );
    expect(result).toEqual({
      kind: 'preset',
      selections: [
        { name: 'Individual portion', quantity: 45 },
        { name: '18 cm cake', quantity: 4 },
      ],
      totalGrams: 45 * 44.5 + 4 * 450,
    });
  });

  it('skips presets that no longer exist and still totals the resolvable ones + extra', () => {
    const result = resolvePrepCardBasis(
      2,
      {
        kind: 'preset',
        selections: [
          { presetId: 'p1', quantity: 10 },
          { presetId: 'gone', quantity: 99 },
        ],
        extraGrams: 100,
      },
      lines,
      presets,
    );
    expect(result).toEqual({
      kind: 'preset',
      selections: [{ name: 'Individual portion', quantity: 10 }],
      totalGrams: 10 * 44.5 + 100,
    });
  });

  it('falls back to factor when every preset in the selection is unresolvable and there is no extra', () => {
    expect(
      resolvePrepCardBasis(
        2,
        { kind: 'preset', selections: [{ presetId: 'gone', quantity: 5 }], extraGrams: 0 },
        lines,
        presets,
      ),
    ).toEqual({ kind: 'factor', factor: 2 });
  });
});

describe('basisCaption', () => {
  it('renders the original caption', () => {
    expect(basisCaption({ kind: 'original' }, labels)).toBe('Original recipe / ×1');
  });

  it('renders a weight-target caption with formatted units', () => {
    expect(basisCaption({ kind: 'weight', grams: 3500 }, labels)).toBe('Target weight: 3,500 g');
  });

  it('renders a line (ingredient-amount) caption', () => {
    expect(
      basisCaption({ kind: 'line', lineName: 'Cream', amount: 900, dimension: 'weight' }, labels),
    ).toBe('Based on Cream: 900 g');
  });

  it('renders a combined-presets caption joined by " + "', () => {
    expect(
      basisCaption(
        {
          kind: 'preset',
          selections: [
            { name: 'Individual portion', quantity: 45 },
            { name: '18 cm cake', quantity: 4 },
          ],
          totalGrams: 3802.5,
        },
        labels,
      ),
    ).toBe('45 × Individual portion + 4 × 18 cm cake — total 3,802.5 g');
  });

  it('renders the generic factor fallback caption', () => {
    expect(basisCaption({ kind: 'factor', factor: 2.5 }, labels)).toBe('Scaled ×2.5');
  });
});
