import { describe, expect, it } from 'vitest';
import {
  explodeSaleConsumption,
  type SaleConsumptionInput,
} from '@/lib/calculations/sale-consumption';
import type { RecipeTreeNode } from '@/lib/calculations/production';

/** A minimal active recipe (item + graph node): yield 1 portion, no loss. */
function recipe(
  recipeId: string,
  plannedQty: number,
  lines: { ingredientId: string; quantity: number }[],
  extra: Partial<RecipeTreeNode> = {},
): { item: { recipeId: string; plannedQty: number }; node: RecipeTreeNode } {
  return {
    item: { recipeId, plannedQty },
    node: {
      available: true,
      yieldPortions: 1,
      yieldPercentage: 100,
      yieldWeightGrams: null,
      lines,
      components: [],
      ...extra,
    },
  };
}

function input(
  over: Partial<Omit<SaleConsumptionInput, 'recipes' | 'recipeNodes'>> & {
    recipes?: { item: { recipeId: string; plannedQty: number }; node: RecipeTreeNode }[];
  } = {},
): SaleConsumptionInput {
  const { recipes = [], ...rest } = over;
  return {
    recipes: recipes.map((r) => r.item),
    recipeNodes: new Map(recipes.map((r) => [r.item.recipeId, r.node])),
    ingredientLines: [],
    ...rest,
  };
}

describe('explodeSaleConsumption', () => {
  it('explodes a recipe-only sale (units = portions)', () => {
    const result = explodeSaleConsumption(
      input({ recipes: [recipe('r1', 3, [{ ingredientId: 'flour', quantity: 100 }])] }),
    );
    expect(result).toEqual({
      complete: true,
      requirements: [{ ingredientId: 'flour', quantityCanonical: 300 }],
    });
  });

  it('aggregates the menu expansion (already summed into recipe portions) across recipes', () => {
    // A menu line "2 × combo" where the combo = 2×r1 + 1×r2 → r1: 4 portions, r2: 2.
    const result = explodeSaleConsumption(
      input({
        recipes: [
          recipe('r1', 4, [{ ingredientId: 'flour', quantity: 50 }]),
          recipe('r2', 2, [{ ingredientId: 'sugar', quantity: 30 }]),
        ],
      }),
    );
    expect(result).toEqual({
      complete: true,
      requirements: [
        { ingredientId: 'flour', quantityCanonical: 200 },
        { ingredientId: 'sugar', quantityCanonical: 60 },
      ],
    });
  });

  it('consumes a direct ingredient line at units × qtyCanonicalPerUnit', () => {
    const result = explodeSaleConsumption(
      input({
        ingredientLines: [
          { ingredientId: 'oil', units: 5, qtyCanonicalPerUnit: 2.5, available: true },
        ],
      }),
    );
    expect(result).toEqual({
      complete: true,
      requirements: [{ ingredientId: 'oil', quantityCanonical: 12.5 }],
    });
  });

  it('merges a recipe and a direct line that hit the same ingredient', () => {
    const result = explodeSaleConsumption(
      input({
        recipes: [recipe('r1', 2, [{ ingredientId: 'flour', quantity: 100 }])],
        ingredientLines: [
          { ingredientId: 'flour', units: 3, qtyCanonicalPerUnit: 10, available: true },
        ],
      }),
    );
    expect(result).toEqual({
      complete: true,
      requirements: [{ ingredientId: 'flour', quantityCanonical: 230 }],
    });
  });

  it('is incomplete (source_unavailable) when a recipe is trashed', () => {
    const result = explodeSaleConsumption(
      input({
        recipes: [recipe('r1', 1, [{ ingredientId: 'flour', quantity: 100 }], { available: false })],
      }),
    );
    expect(result.complete).toBe(false);
    expect(result.complete === false && result.reason).toBe('source_unavailable');
    expect(result.complete === false && result.unavailableSourceIds).toEqual(['r1']);
  });

  it('is incomplete (source_unavailable) when a direct ingredient is trashed', () => {
    const result = explodeSaleConsumption(
      input({
        ingredientLines: [
          { ingredientId: 'oil', units: 1, qtyCanonicalPerUnit: 1, available: false },
        ],
      }),
    );
    expect(result.complete).toBe(false);
    expect(result.complete === false && result.unavailableSourceIds).toEqual(['oil']);
  });

  it('is incomplete when a trashed menu id is reported by the resolver', () => {
    const result = explodeSaleConsumption(input({ unavailableSourceIds: ['menu-x'] }));
    expect(result.complete).toBe(false);
    expect(result.complete === false && result.reason).toBe('source_unavailable');
    expect(result.complete === false && result.unavailableSourceIds).toEqual(['menu-x']);
  });

  it('rejects invalid direct-line math (non-positive / non-finite) rather than clamping', () => {
    expect(
      explodeSaleConsumption(
        input({
          ingredientLines: [
            { ingredientId: 'oil', units: 0, qtyCanonicalPerUnit: 1, available: true },
          ],
        }),
      ).complete,
    ).toBe(false);
    expect(
      explodeSaleConsumption(
        input({
          ingredientLines: [
            { ingredientId: 'oil', units: 1, qtyCanonicalPerUnit: 0, available: true },
          ],
        }),
      ).complete,
    ).toBe(false);
  });

  it('rejects an over-domain total as overflow', () => {
    const result = explodeSaleConsumption(
      input({
        ingredientLines: [
          {
            ingredientId: 'bulk',
            units: 100000,
            qtyCanonicalPerUnit: 1_000_000,
            available: true,
          },
        ],
      }),
    );
    expect(result.complete).toBe(false);
    expect(result.complete === false && result.reason).toBe('overflow');
  });

  it('is complete-and-empty for a sale with no consuming lines', () => {
    expect(explodeSaleConsumption(input())).toEqual({ complete: true, requirements: [] });
  });
});
