import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/lib/i18n/messages/en.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/app/(app)/menus/actions', () => ({
  createDishAction: vi.fn(),
  updateDishAction: vi.fn(),
  deleteMenuAction: vi.fn(),
  duplicateDishAction: vi.fn(),
  markDishOpenedAction: vi.fn(async () => ({ ok: true })),
}));

import { DishBuilder, type DishBuilderInitial } from '@/components/app/menus/dish-builder';
import type { DishIngredientOption, DishRecipeOption } from '@/lib/data/menus';

/**
 * The dish editor's first paint for the brief's worked example: 300 mini cakes at €3
 * excl. VAT; food €183 (10 kg sponge = €60, 10.25 kg fruit = €123); packaging €12
 * (300 sleeves); 8 h × €20; €25 expenses.
 */
const recipeOptions: DishRecipeOption[] = [
  {
    id: 'sponge',
    name: 'Chocolate sponge',
    yieldPortions: 20,
    yieldWeightGrams: 2_000,
    ingredientCostCents: 1_200,
    ingredientCostPerKgCents: 600,
    legacyExtraCostCents: 0,
  },
];
const ingredientOptions: DishIngredientOption[] = [
  { id: 'fruit', name: 'Passion fruit', dimension: 'weight', priceCents: 1_200, needsPricing: false, costKind: 'food' },
  { id: 'sleeve', name: 'Paper sleeve', dimension: 'count', priceCents: 4, needsPricing: false, costKind: 'packaging' },
  { id: 'cream', name: 'Cream', dimension: 'volume', priceCents: 500, needsPricing: false, costKind: null },
];

function initial(over: Partial<DishBuilderInitial> = {}): DishBuilderInitial {
  return {
    id: 'dish_1',
    name: 'Mini passion cakes',
    folderId: null,
    output: { quantity: 300, unit: 'portion', sizeDescription: null, label: 'mini cakes', finishedWeightGrams: null },
    sellingPriceCents: 300,
    vatRateBps: 1_350,
    displayUnit: 'g',
    labour: { hours: 8, hourlyCents: 2_000 },
    extras: [{ kind: 'expense', description: 'Parking', amountCents: 2_500 }],
    notes: null,
    recipeLines: [{ recipeId: 'sponge', recipeName: 'Chocolate sponge', quantity: 10_000, unit: 'g', available: true }],
    ingredientLines: [
      { ingredientId: 'fruit', ingredientName: 'Passion fruit', quantity: 10_250, unit: 'g', available: true },
      { ingredientId: 'sleeve', ingredientName: 'Paper sleeve', quantity: 300, unit: 'piece', available: true },
    ],
    ...over,
  };
}

function render(data: DishBuilderInitial) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DishBuilder
        initial={data}
        folders={[{ id: 'f1', name: 'Catering', parentId: null }]}
        recipeOptions={recipeOptions}
        ingredientOptions={ingredientOptions}
        currency="EUR"
        defaultVatBps={2_300}
      />
    </NextIntlClientProvider>,
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('dish editor', () => {
  it('lays the page out in the approved order', () => {
    const html = text(render(initial()));
    const order = [
      'These quantities make',
      'Recipes',
      'Direct ingredients',
      'Labour',
      'Extra costs',
      'Selling price / mini cakes',
      'Earned / work hour',
      'Target ingredient margin',
      'Notes (optional)',
    ].map((label) => html.indexOf(label));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('Save dish');
    expect(html).toContain('Cancel');
  });

  it('shows the three results for the worked example', () => {
    const html = render(initial());
    expect(html).toMatch(/data-testid="earned-per-hour"[^>]*>€65\.00</);
    const plain = text(html);
    expect(plain).toContain('Total cost / item');
    expect(plain).toContain('€1.27');
    expect(plain).toContain('Ingredient margin');
    expect(plain).toContain('79.7%');
    expect(plain).toContain('20.3% food cost');
    expect(plain).toContain('If all 300 mini cakes sell at €3.00 excl. VAT.');
    // Extra costs show their total while collapsed.
    expect(plain).toMatch(/Extra costs\s+€25\.00/);
    // Primary price excl. VAT, secondary incl. VAT at the dish's own rate.
    expect(html).toMatch(/id="price-excl"[^>]*value="3\.00"/);
    expect(html).toMatch(/id="price-incl"[^>]*value="3\.41"/);
  });

  it('drops the old ambiguous wording and the visible VAT paragraph', () => {
    const plain = text(render(initial()));
    for (const gone of ['Selling price per portion', 'Amount left per portion', 'Using 13.5% for this dish', 'Ingredients and packaging', 'Margin calculator']) {
      expect(plain).not.toContain(gone);
    }
  });

  it('shows weights in the dish unit, pieces as pieces, and a packaging choice', () => {
    const grams = render(initial());
    expect(grams).toMatch(/aria-label="Quantity of Chocolate sponge in g"[^>]*value="10000"/);
    expect(grams).toMatch(/aria-label="Quantity of Paper sleeve in pcs"[^>]*value="300"/);
    expect(grams).toMatch(/role="radio" aria-checked="true"[^>]*data-unit="g"/);
    expect(grams).toMatch(/aria-checked="true"[^>]*data-kind="packaging"/);
    const kilos = render(initial({ displayUnit: 'kg' }));
    expect(kilos).toMatch(/aria-label="Quantity of Chocolate sponge in kg"[^>]*value="10"/);
    expect(kilos).toMatch(/aria-label="Quantity of Passion fruit in kg"[^>]*value="10\.25"/);
    expect(kilos).toMatch(/aria-label="Quantity of Paper sleeve in pcs"[^>]*value="300"/);
  });

  it('marks missing labour and unclassified items instead of treating them as zero', () => {
    const html = render(
      initial({
        labour: null,
        ingredientLines: [
          { ingredientId: 'fruit', ingredientName: 'Passion fruit', quantity: 10_250, unit: 'g', available: true },
          { ingredientId: 'cream', ingredientName: 'Cream', quantity: 0.5, unit: 'l', available: true },
        ],
      }),
    );
    expect(html).toMatch(/data-testid="earned-per-hour"[^>]*>—</);
    const plain = text(html);
    expect(plain).toContain('Labour not entered');
    expect(plain).toContain('Mark 1 direct ingredient as food or packaging');
    expect(plain).toContain('Food or packaging?');
    // Volume keeps its own unit.
    expect(html).toMatch(/aria-label="Quantity of Cream in l"[^>]*value="0\.5"/);
  });

  it('defaults a new dish to grams and one portion, with nothing suggested until a target is typed', () => {
    const html = render(
      initial({
        id: null,
        name: '',
        output: { quantity: 1, unit: 'portion', sizeDescription: null, label: null, finishedWeightGrams: null },
        sellingPriceCents: null,
        vatRateBps: null,
        labour: null,
        extras: [],
        recipeLines: [],
        ingredientLines: [],
      }),
    );
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*data-unit="g"/);
    expect(text(html)).toContain('Selling price / portion');
    expect(html).toMatch(/data-testid="suggested-price"[^>]*>—</);
    expect(text(html)).toContain('Extra costs None');
  });
});
