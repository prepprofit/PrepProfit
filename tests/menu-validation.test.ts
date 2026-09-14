import { describe, expect, it } from 'vitest';
import { dishSchema, dishSearchSchema, menuFolderSchema } from '@/lib/validation/menus';

const base = {
  name: 'Caesar salad',
  folderId: null,
  output: { quantity: 1, unit: 'portion', sizeDescription: null, finishedWeightGrams: null },
  sellingPriceCents: 1_200,
  priceBasis: 'unit',
  vatRateBps: null,
  labour: null,
  extras: [],
  notes: '',
  recipeLines: [{ recipeId: 'r1', quantity: 150, unit: 'g' }],
  ingredientLines: [{ ingredientId: 'i1', quantity: 1, unit: 'piece' }],
};

describe('dishSchema', () => {
  it('accepts a valid dish and normalises empty notes to null', () => {
    const parsed = dishSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.notes).toBeNull();
  });

  it('accepts an empty draft and an unpriced dish', () => {
    expect(dishSchema.safeParse({ ...base, recipeLines: [], ingredientLines: [] }).success).toBe(true);
    expect(dishSchema.safeParse({ ...base, sellingPriceCents: null }).success).toBe(true);
  });

  it('accepts fractional amounts but rejects zero, negative and non-finite', () => {
    expect(dishSchema.safeParse({ ...base, recipeLines: [{ recipeId: 'r1', quantity: 0.25, unit: 'kg' }] }).success).toBe(true);
    for (const quantity of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 100_000_000]) {
      expect(dishSchema.safeParse({ ...base, recipeLines: [{ recipeId: 'r1', quantity, unit: 'g' }] }).success).toBe(false);
    }
  });

  it('rejects unknown units, duplicates, bad portions, price and VAT', () => {
    expect(dishSchema.safeParse({ ...base, recipeLines: [{ recipeId: 'r1', quantity: 1, unit: 'cup' }] }).success).toBe(false);
    expect(dishSchema.safeParse({ ...base, ingredientLines: [{ ingredientId: 'i1', quantity: 1, unit: 'portion' }] }).success).toBe(false);
    expect(
      dishSchema.safeParse({
        ...base,
        recipeLines: [
          { recipeId: 'r1', quantity: 1, unit: 'g' },
          { recipeId: 'r1', quantity: 2, unit: 'g' },
        ],
      }).success,
    ).toBe(false);
    expect(
      dishSchema.safeParse({
        ...base,
        ingredientLines: [
          { ingredientId: 'i1', quantity: 1, unit: 'piece' },
          { ingredientId: 'i1', quantity: 1, unit: 'piece' },
        ],
      }).success,
    ).toBe(false);
    for (const quantity of [0, -1, Number.NaN, 100_000_000]) {
      expect(dishSchema.safeParse({ ...base, output: { ...base.output, quantity } }).success).toBe(false);
    }
    expect(dishSchema.safeParse({ ...base, sellingPriceCents: -1 }).success).toBe(false);
    expect(dishSchema.safeParse({ ...base, sellingPriceCents: 1.5 }).success).toBe(false);
    expect(dishSchema.safeParse({ ...base, vatRateBps: 10_001 }).success).toBe(false);
    expect(dishSchema.safeParse({ ...base, name: '   ' }).success).toBe(false);
  });

  it('caps the number of lines', () => {
    const recipeLines = Array.from({ length: 101 }, (_, i) => ({ recipeId: `r${i}`, quantity: 1, unit: 'portion' }));
    expect(dishSchema.safeParse({ ...base, recipeLines }).success).toBe(false);
  });
});

describe('folder + search schemas', () => {
  it('trims and bounds names and queries', () => {
    expect(menuFolderSchema.safeParse({ name: '  Bakery ' }).success).toBe(true);
    expect(menuFolderSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(menuFolderSchema.safeParse({ name: 'x'.repeat(81) }).success).toBe(false);
    expect(dishSearchSchema.safeParse({ query: '' }).success).toBe(false);
    expect(dishSearchSchema.safeParse({ query: 'x'.repeat(101) }).success).toBe(false);
  });
});
