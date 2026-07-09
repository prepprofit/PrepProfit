import { describe, expect, it } from 'vitest';
import {
  componentRawCostCents,
  recipeCost,
  type RecipeCostInput,
} from './recipeCost';
import {
  explodeRecipeTree,
  MAX_COMPONENT_DEPTH,
  type RecipeTreeNode,
} from './production';
import { recipeAllergens, type RecipeAllergenRollup } from './allergens';

// ---------------------------------------------------------------------------
// componentRawCostCents (sub-recipes plan, locked math)
// ---------------------------------------------------------------------------

describe('componentRawCostCents', () => {
  it('slices the exact batch total by finished weight', () => {
    // 1000-cent batch yielding 500 g, 250 g used → 500 cents.
    expect(componentRawCostCents(1000, 250, 500)).toBe(500);
  });

  it('keeps fractional cents (no per-line rounding)', () => {
    expect(componentRawCostCents(1000, 333, 1000)).toBeCloseTo(333, 10);
    expect(componentRawCostCents(100, 1, 3)).toBeCloseTo(100 / 3, 10);
  });

  it('returns null on missing/zero/negative/non-finite yield weight', () => {
    expect(componentRawCostCents(1000, 100, null)).toBeNull();
    expect(componentRawCostCents(1000, 100, undefined)).toBeNull();
    expect(componentRawCostCents(1000, 100, 0)).toBeNull();
    expect(componentRawCostCents(1000, 100, -5)).toBeNull();
    expect(componentRawCostCents(1000, 100, Number.NaN)).toBeNull();
    expect(componentRawCostCents(1000, 100, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('returns null on invalid quantity or non-finite total', () => {
    expect(componentRawCostCents(1000, 0, 500)).toBeNull();
    expect(componentRawCostCents(1000, -1, 500)).toBeNull();
    expect(componentRawCostCents(1000, Number.NaN, 500)).toBeNull();
    expect(componentRawCostCents(Number.NaN, 100, 500)).toBeNull();
    expect(componentRawCostCents(Number.POSITIVE_INFINITY, 100, 500)).toBeNull();
  });

  it('handles large values without precision surprises at cents scale', () => {
    expect(componentRawCostCents(10_000_000_00, 100_000, 100_000)).toBe(
      10_000_000_00,
    );
  });
});

describe('recipeCost with componentMaterialCostsCents', () => {
  const base: RecipeCostInput = {
    yieldPortions: 10,
    yieldPercentage: 100,
    laborCostCents: 0,
    energyCostCents: 0,
    packagingCostCents: 0,
    lines: [{ dimension: 'weight', priceCents: 100, quantity: 1000 }], // 100
  };

  it('adds component material cost before the loss adjustment', () => {
    // raw material = 100 + 150 = 250; 80% yield → 312.5 → round once = 313.
    const cost = recipeCost({
      ...base,
      yieldPercentage: 80,
      componentMaterialCostsCents: [150],
    });
    expect(cost.ingredientCostCents).toBe(313);
    expect(cost.totalCostCents).toBe(313);
  });

  it('does NOT loss-adjust hidden costs, exactly as today', () => {
    const cost = recipeCost({
      ...base,
      yieldPercentage: 50,
      laborCostCents: 100,
      componentMaterialCostsCents: [100],
    });
    // (100 + 100) / 0.5 = 400 material; + 100 labor = 500.
    expect(cost.ingredientCostCents).toBe(400);
    expect(cost.hiddenCostCents).toBe(100);
    expect(cost.totalCostCents).toBe(500);
  });

  it('rounds once at the batch boundary with fractional component costs', () => {
    const cost = recipeCost({
      ...base,
      componentMaterialCostsCents: [100 / 3, 100 / 3, 100 / 3],
    });
    // 100 + 99.999… = 200 (round once), not 33+33+33=99 → 199.
    expect(cost.totalCostCents).toBe(200);
  });

  it('is byte-identical for component-free input (regression)', () => {
    expect(recipeCost(base)).toEqual(
      recipeCost({ ...base, componentMaterialCostsCents: [] }),
    );
  });
});

// ---------------------------------------------------------------------------
// explodeRecipeTree
// ---------------------------------------------------------------------------

const node = (partial: Partial<RecipeTreeNode>): RecipeTreeNode => ({
  available: true,
  yieldPortions: 1,
  yieldPercentage: 100,
  yieldWeightGrams: null,
  lines: [],
  components: [],
  ...partial,
});

describe('explodeRecipeTree', () => {
  it('matches single-level semantics for component-free recipes', () => {
    const nodes = new Map<string, RecipeTreeNode>([
      [
        'r1',
        node({
          yieldPortions: 10,
          yieldPercentage: 80,
          lines: [{ ingredientId: 'flour', quantity: 1000 }],
        }),
      ],
    ]);
    const result = explodeRecipeTree([{ recipeId: 'r1', plannedQty: 4 }], nodes);
    expect(result.complete).toBe(true);
    if (result.complete) {
      // 1000 × 4 / 10 / 0.8 = 500
      expect(result.requirements).toEqual([
        { ingredientId: 'flour', quantityCanonical: 500 },
      ]);
    }
  });

  it('explodes a 2-level tree through the child batch scale + child loss', () => {
    const nodes = new Map<string, RecipeTreeNode>([
      [
        'parent',
        node({
          yieldPortions: 2,
          yieldPercentage: 100,
          lines: [{ ingredientId: 'sugar', quantity: 100 }],
          components: [{ componentRecipeId: 'dough', quantityGrams: 500 }],
        }),
      ],
      [
        'dough',
        node({
          yieldPercentage: 80,
          yieldWeightGrams: 1000,
          lines: [{ ingredientId: 'flour', quantity: 800 }],
        }),
      ],
    ]);
    const result = explodeRecipeTree([{ recipeId: 'parent', plannedQty: 4 }], nodes);
    expect(result.complete).toBe(true);
    if (result.complete) {
      // parentScale = 4/2/1 = 2 → sugar 200; dough finished needed = 500×2 = 1000 g
      // childBatchScale = 1000/1000 = 1; child loss 80% → flour 800/0.8 = 1000.
      expect(result.requirements).toEqual([
        { ingredientId: 'flour', quantityCanonical: 1000 },
        { ingredientId: 'sugar', quantityCanonical: 200 },
      ]);
    }
  });

  it('explodes a 3-level tree and aggregates shared raw ingredients', () => {
    const nodes = new Map<string, RecipeTreeNode>([
      [
        'cake',
        node({
          lines: [{ ingredientId: 'flour', quantity: 100 }],
          components: [{ componentRecipeId: 'cream', quantityGrams: 200 }],
        }),
      ],
      [
        'cream',
        node({
          yieldWeightGrams: 400,
          lines: [{ ingredientId: 'milk', quantity: 300 }],
          components: [{ componentRecipeId: 'praline', quantityGrams: 100 }],
        }),
      ],
      [
        'praline',
        node({
          yieldWeightGrams: 200,
          lines: [{ ingredientId: 'flour', quantity: 50 }],
        }),
      ],
    ]);
    const result = explodeRecipeTree([{ recipeId: 'cake', plannedQty: 1 }], nodes);
    expect(result.complete).toBe(true);
    if (result.complete) {
      // cream scale = 200/400 = 0.5 → milk 150, praline needed 50 g → scale 0.25
      // flour: 100 (direct) + 50×0.25 = 112.5
      expect(result.requirements).toEqual([
        { ingredientId: 'flour', quantityCanonical: 112.5 },
        { ingredientId: 'milk', quantityCanonical: 150 },
      ]);
    }
  });

  it('reports a trashed/missing component as recipe_unavailable', () => {
    const nodes = new Map<string, RecipeTreeNode>([
      [
        'parent',
        node({
          lines: [{ ingredientId: 'sugar', quantity: 100 }],
          components: [{ componentRecipeId: 'ghost', quantityGrams: 100 }],
        }),
      ],
      ['ghost', node({ available: false, yieldWeightGrams: 100 })],
    ]);
    const result = explodeRecipeTree([{ recipeId: 'parent', plannedQty: 1 }], nodes);
    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.reason).toBe('recipe_unavailable');
      expect(result.unavailableRecipeIds).toEqual(['ghost']);
    }
  });

  it('treats a no-yield component as invalid_math (never a silent skip)', () => {
    const nodes = new Map<string, RecipeTreeNode>([
      [
        'parent',
        node({ components: [{ componentRecipeId: 'child', quantityGrams: 100 }] }),
      ],
      ['child', node({ yieldWeightGrams: null })],
    ]);
    const result = explodeRecipeTree([{ recipeId: 'parent', plannedQty: 1 }], nodes);
    expect(result.complete).toBe(false);
    if (!result.complete) expect(result.reason).toBe('invalid_math');
  });

  it('never loops on a (corrupted) cycle — incomplete instead', () => {
    const nodes = new Map<string, RecipeTreeNode>([
      [
        'a',
        node({
          yieldWeightGrams: 100,
          components: [{ componentRecipeId: 'b', quantityGrams: 50 }],
        }),
      ],
      [
        'b',
        node({
          yieldWeightGrams: 100,
          components: [{ componentRecipeId: 'a', quantityGrams: 50 }],
        }),
      ],
    ]);
    const result = explodeRecipeTree([{ recipeId: 'a', plannedQty: 1 }], nodes);
    expect(result.complete).toBe(false);
    if (!result.complete) expect(result.reason).toBe('invalid_math');
  });

  it(`rejects chains deeper than MAX_COMPONENT_DEPTH (${MAX_COMPONENT_DEPTH})`, () => {
    const nodes = new Map<string, RecipeTreeNode>();
    // r0 → r1 → … → r6 (depth 6 links).
    for (let i = 0; i <= 6; i += 1) {
      nodes.set(
        `r${i}`,
        node({
          yieldWeightGrams: 100,
          lines: [{ ingredientId: `ing${i}`, quantity: 10 }],
          components:
            i < 6 ? [{ componentRecipeId: `r${i + 1}`, quantityGrams: 50 }] : [],
        }),
      );
    }
    const result = explodeRecipeTree([{ recipeId: 'r0', plannedQty: 1 }], nodes);
    expect(result.complete).toBe(false);
    if (!result.complete) expect(result.reason).toBe('invalid_math');

    // Depth exactly MAX (5 links, r0..r5) is fine.
    const okNodes = new Map(nodes);
    okNodes.set(
      'r5',
      node({ yieldWeightGrams: 100, lines: [{ ingredientId: 'ing5', quantity: 10 }] }),
    );
    const ok = explodeRecipeTree([{ recipeId: 'r0', plannedQty: 1 }], okNodes);
    expect(ok.complete).toBe(true);
  });

  it('a diamond (shared component via two paths) is NOT a cycle', () => {
    const nodes = new Map<string, RecipeTreeNode>([
      [
        'top',
        node({
          components: [
            { componentRecipeId: 'left', quantityGrams: 100 },
            { componentRecipeId: 'right', quantityGrams: 100 },
          ],
        }),
      ],
      [
        'left',
        node({
          yieldWeightGrams: 100,
          components: [{ componentRecipeId: 'base', quantityGrams: 50 }],
        }),
      ],
      [
        'right',
        node({
          yieldWeightGrams: 100,
          components: [{ componentRecipeId: 'base', quantityGrams: 50 }],
        }),
      ],
      [
        'base',
        node({
          yieldWeightGrams: 100,
          lines: [{ ingredientId: 'flour', quantity: 100 }],
        }),
      ],
    ]);
    const result = explodeRecipeTree([{ recipeId: 'top', plannedQty: 1 }], nodes);
    expect(result.complete).toBe(true);
    if (result.complete) {
      // Each path: 100/100 = 1 batch of left/right → 50/100 = 0.5 base → 50 flour ×2.
      expect(result.requirements).toEqual([
        { ingredientId: 'flour', quantityCanonical: 100 },
      ]);
    }
  });

  it('rejects overflow beyond the numeric(12,2) domain', () => {
    const nodes = new Map<string, RecipeTreeNode>([
      [
        'parent',
        node({
          lines: [{ ingredientId: 'x', quantity: 9_999_999_999.99 }],
          components: [{ componentRecipeId: 'child', quantityGrams: 100 }],
        }),
      ],
      [
        'child',
        node({
          yieldWeightGrams: 0.01,
          lines: [{ ingredientId: 'x', quantity: 9_999_999_999.99 }],
        }),
      ],
    ]);
    const result = explodeRecipeTree([{ recipeId: 'parent', plannedQty: 1 }], nodes);
    expect(result.complete).toBe(false);
    if (!result.complete) expect(result.reason).toBe('overflow');
  });

  it('rejects duplicate items and non-positive planned portions', () => {
    const nodes = new Map<string, RecipeTreeNode>([['r', node({})]]);
    expect(
      explodeRecipeTree(
        [
          { recipeId: 'r', plannedQty: 1 },
          { recipeId: 'r', plannedQty: 2 },
        ],
        nodes,
      ).complete,
    ).toBe(false);
    expect(explodeRecipeTree([{ recipeId: 'r', plannedQty: 0 }], nodes).complete).toBe(
      false,
    );
    expect(explodeRecipeTree([], nodes).complete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recipeAllergens with inherited component rollups
// ---------------------------------------------------------------------------

describe('recipeAllergens with inherited component rollups', () => {
  const inherited = (
    allergens: RecipeAllergenRollup['allergens'],
    hasUnreviewedIngredient = false,
  ): RecipeAllergenRollup => ({ allergens, hasUnreviewedIngredient });

  it('inherited effective presences merge as derived', () => {
    const rollup = recipeAllergens(
      [
        {
          reviewed: true,
          allergens: [{ allergen: 'milk', presence: 'may_contain' }],
        },
      ],
      [],
      [
        inherited([
          {
            allergen: 'milk',
            derivedPresence: 'contains',
            overridePresence: null,
            effectivePresence: 'contains',
          },
          {
            allergen: 'eggs',
            derivedPresence: null,
            overridePresence: 'may_contain',
            effectivePresence: 'may_contain',
          },
        ]),
      ],
    );
    const byAllergen = new Map(rollup.allergens.map((a) => [a.allergen, a]));
    expect(byAllergen.get('milk')?.derivedPresence).toBe('contains');
    expect(byAllergen.get('milk')?.effectivePresence).toBe('contains');
    expect(byAllergen.get('eggs')?.derivedPresence).toBe('may_contain');
  });

  it('a parent override can never suppress an inherited allergen (no-downgrade)', () => {
    const rollup = recipeAllergens(
      [],
      [{ allergen: 'milk', presence: 'may_contain' }],
      [
        inherited([
          {
            allergen: 'milk',
            derivedPresence: 'contains',
            overridePresence: null,
            effectivePresence: 'contains',
          },
        ]),
      ],
    );
    expect(rollup.allergens[0]?.effectivePresence).toBe('contains');
  });

  it('a parent override can still escalate above inherited', () => {
    const rollup = recipeAllergens(
      [],
      [{ allergen: 'milk', presence: 'contains' }],
      [
        inherited([
          {
            allergen: 'milk',
            derivedPresence: 'may_contain',
            overridePresence: null,
            effectivePresence: 'may_contain',
          },
        ]),
      ],
    );
    expect(rollup.allergens[0]?.effectivePresence).toBe('contains');
  });

  it('unreviewed flag bubbles up from any component subtree', () => {
    const rollup = recipeAllergens([], [], [inherited([], true)]);
    expect(rollup.hasUnreviewedIngredient).toBe(true);
  });

  it('is unchanged for component-free calls (regression)', () => {
    const lines = [
      {
        reviewed: false,
        allergens: [{ allergen: 'milk' as const, presence: 'contains' as const }],
      },
    ];
    expect(recipeAllergens(lines, [])).toEqual(recipeAllergens(lines, [], []));
  });
});
