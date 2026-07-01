import { describe, expect, it } from 'vitest';
import {
  projectPendingCostImpact,
  type CostImpactIngredient,
  type CostImpactMenu,
  type CostImpactRecipe,
  type ProjectPendingCostImpactInput,
} from './cost-impact';

/**
 * A recipe with a single 1 kg weight line of `ingredientId`. With yieldPortions =
 * 1 and no loss/hidden costs, cost per portion == that ingredient's priceCents.
 */
function recipe(
  id: string,
  sellingPriceCents: number | null,
  ingredientIds: string[],
): CostImpactRecipe {
  return {
    id,
    name: `Recipe ${id}`,
    sellingPriceCents,
    yieldPortions: 1,
    yieldPercentage: 100,
    laborCostCents: 0,
    energyCostCents: 0,
    packagingCostCents: 0,
    lines: ingredientIds.map((ingredientId) => ({
      ingredientId,
      dimension: 'weight' as const,
      quantity: 1000,
    })),
  };
}

function ingredient(
  id: string,
  overrides: Partial<CostImpactIngredient> = {},
): CostImpactIngredient {
  return {
    id,
    name: `Ingredient ${id}`,
    priceCents: 1000,
    pendingPriceCents: null,
    needsPricing: false,
    ...overrides,
  };
}

function menu(
  id: string,
  sellingPriceCents: number | null,
  lines: { recipeId: string; quantity: number }[],
): CostImpactMenu {
  return { id, name: `Menu ${id}`, sellingPriceCents, lines };
}

function input(partial: Partial<ProjectPendingCostImpactInput>): ProjectPendingCostImpactInput {
  return {
    ingredients: partial.ingredients ?? [],
    recipes: partial.recipes ?? [],
    menus: partial.menus ?? [],
    focusIngredientIds: partial.focusIngredientIds ?? [],
    targetMarginPercent: partial.targetMarginPercent,
  };
}

describe('projectPendingCostImpact — ingredient changes', () => {
  it('reports a pending increase with the correct percent change', () => {
    const result = projectPendingCostImpact(
      input({
        ingredients: [ingredient('butter', { priceCents: 820, pendingPriceCents: 970 })],
        focusIngredientIds: ['butter'],
      }),
    );
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0]!;
    expect(change.currentCostCents).toBe(820);
    expect(change.projectedCostCents).toBe(970);
    // (970 - 820) / 820 = 18.29% → 18.3
    expect(change.percentChange).toBeCloseTo(18.3, 5);
    expect(result.summary.ingredientsChangedCount).toBe(1);
  });

  it('ignores a focus ingredient whose pending equals the approved cost', () => {
    const result = projectPendingCostImpact(
      input({
        ingredients: [ingredient('a', { priceCents: 1000, pendingPriceCents: 1000 })],
        focusIngredientIds: ['a'],
      }),
    );
    expect(result.changes).toHaveLength(0);
    expect(result.summary.ingredientsChangedCount).toBe(0);
  });

  it('ignores a focus ingredient with no pending observation', () => {
    const result = projectPendingCostImpact(
      input({
        ingredients: [ingredient('a', { priceCents: 1000, pendingPriceCents: null })],
        focusIngredientIds: ['a'],
      }),
    );
    expect(result.changes).toHaveLength(0);
  });

  it('reports a pending decrease as a negative percent change', () => {
    const result = projectPendingCostImpact(
      input({
        ingredients: [ingredient('a', { priceCents: 1000, pendingPriceCents: 800 })],
        focusIngredientIds: ['a'],
      }),
    );
    expect(result.changes[0]!.percentChange).toBeCloseTo(-20, 5);
  });

  it('reports a null percent change when the ingredient was previously unpriced', () => {
    const result = projectPendingCostImpact(
      input({
        ingredients: [
          ingredient('a', { priceCents: 0, pendingPriceCents: 950, needsPricing: true }),
        ],
        focusIngredientIds: ['a'],
      }),
    );
    expect(result.changes[0]!.percentChange).toBeNull();
  });

  it('only reports changes for focused ingredients', () => {
    const result = projectPendingCostImpact(
      input({
        ingredients: [
          ingredient('a', { priceCents: 1000, pendingPriceCents: 1200 }),
          ingredient('b', { priceCents: 1000, pendingPriceCents: 1500 }),
        ],
        focusIngredientIds: ['a'],
      }),
    );
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]!.ingredientId).toBe('a');
  });
});

describe('projectPendingCostImpact — affected recipes', () => {
  it('computes current vs projected margin for an affected recipe', () => {
    // price 2000; cost 1000 → 50%; pending 1400 → margin 30%.
    const result = projectPendingCostImpact(
      input({
        ingredients: [ingredient('a', { priceCents: 1000, pendingPriceCents: 1400 })],
        recipes: [recipe('r', 2000, ['a'])],
        focusIngredientIds: ['a'],
      }),
    );
    expect(result.affectedRecipes).toHaveLength(1);
    const r = result.affectedRecipes[0]!;
    expect(r.currentCostPerPortionCents).toBe(1000);
    expect(r.projectedCostPerPortionCents).toBe(1400);
    expect(r.currentMarginPercent).toBe(50);
    expect(r.projectedMarginPercent).toBe(30);
    expect(r.suggestedPriceCents).toBe(4000); // 1400 / (1 - 0.65)
  });

  it('flags a recipe that crosses below target because of the pending cost', () => {
    // price 3000; cost 1000 → 66.7% (>= 65); pending 1200 → 60% (< 65).
    const result = projectPendingCostImpact(
      input({
        ingredients: [ingredient('a', { priceCents: 1000, pendingPriceCents: 1200 })],
        recipes: [recipe('r', 3000, ['a'])],
        focusIngredientIds: ['a'],
      }),
    );
    const r = result.affectedRecipes[0]!;
    expect(r.belowTarget).toBe(true);
    expect(r.crossesBelowTarget).toBe(true);
    expect(result.summary.recipesBelowTargetCount).toBe(1);
  });

  it('does not mark crossesBelowTarget when the recipe was already below target', () => {
    // price 2000; cost 1000 → 50% (already below 65); pending 1100 → 45%.
    const result = projectPendingCostImpact(
      input({
        ingredients: [ingredient('a', { priceCents: 1000, pendingPriceCents: 1100 })],
        recipes: [recipe('r', 2000, ['a'])],
        focusIngredientIds: ['a'],
      }),
    );
    const r = result.affectedRecipes[0]!;
    expect(r.belowTarget).toBe(true);
    expect(r.crossesBelowTarget).toBe(false);
  });

  it('leaves margins null when the recipe has no selling price', () => {
    const result = projectPendingCostImpact(
      input({
        ingredients: [ingredient('a', { priceCents: 1000, pendingPriceCents: 1400 })],
        recipes: [recipe('r', null, ['a'])],
        focusIngredientIds: ['a'],
      }),
    );
    const r = result.affectedRecipes[0]!;
    expect(r.currentMarginPercent).toBeNull();
    expect(r.projectedMarginPercent).toBeNull();
    expect(r.belowTarget).toBe(false);
  });

  it('does not affect a recipe that does not use the changed ingredient', () => {
    const result = projectPendingCostImpact(
      input({
        ingredients: [
          ingredient('a', { priceCents: 1000, pendingPriceCents: 1400 }),
          ingredient('b'),
        ],
        recipes: [recipe('r', 2000, ['b'])],
        focusIngredientIds: ['a'],
      }),
    );
    expect(result.affectedRecipes).toHaveLength(0);
  });

  it('keeps cost null when an OTHER ingredient in the recipe is still unpriced', () => {
    // 'a' changes, but 'b' is unpriced and unresolved → recipe cost stays untrue.
    const result = projectPendingCostImpact(
      input({
        ingredients: [
          ingredient('a', { priceCents: 1000, pendingPriceCents: 1400 }),
          ingredient('b', { priceCents: 0, pendingPriceCents: null, needsPricing: true }),
        ],
        recipes: [recipe('r', 2000, ['a', 'b'])],
        focusIngredientIds: ['a'],
      }),
    );
    const r = result.affectedRecipes[0]!;
    expect(r.currentCostPerPortionCents).toBeNull();
    expect(r.projectedCostPerPortionCents).toBeNull();
    expect(r.currentMarginPercent).toBeNull();
    expect(r.projectedMarginPercent).toBeNull();
  });

  it('resolves a previously-unpriced recipe when the invoice prices its only unpriced ingredient', () => {
    // 'a' was unpriced (cost untrue); the invoice's pending 1000 makes it real.
    const result = projectPendingCostImpact(
      input({
        ingredients: [
          ingredient('a', { priceCents: 0, pendingPriceCents: 1000, needsPricing: true }),
        ],
        recipes: [recipe('r', 4000, ['a'])],
        focusIngredientIds: ['a'],
      }),
    );
    const r = result.affectedRecipes[0]!;
    expect(r.currentCostPerPortionCents).toBeNull(); // was untrue
    expect(r.currentMarginPercent).toBeNull();
    expect(r.projectedCostPerPortionCents).toBe(1000);
    expect(r.projectedMarginPercent).toBe(75); // (4000-1000)/4000
  });
});

describe('projectPendingCostImpact — affected menus', () => {
  it('projects a menu margin from its component recipe cost change', () => {
    // menu = 1× recipe r; price 3000. cost 1000 → 66.7%; pending 1400 → 53.3%.
    const result = projectPendingCostImpact(
      input({
        ingredients: [ingredient('a', { priceCents: 1000, pendingPriceCents: 1400 })],
        recipes: [recipe('r', null, ['a'])],
        menus: [menu('m', 3000, [{ recipeId: 'r', quantity: 1 }])],
        focusIngredientIds: ['a'],
      }),
    );
    expect(result.affectedMenus).toHaveLength(1);
    const m = result.affectedMenus[0]!;
    expect(m.currentCostCents).toBe(1000);
    expect(m.projectedCostCents).toBe(1400);
    expect(m.currentMarginPercent).toBeCloseTo(66.7, 1);
    expect(m.projectedMarginPercent).toBeCloseTo(53.3, 1);
    expect(m.belowTarget).toBe(true);
    expect(m.crossesBelowTarget).toBe(true);
    expect(result.summary.menusBelowTargetCount).toBe(1);
  });

  it('keeps an incomplete menu incomplete (a component recipe is missing)', () => {
    // menu references recipe 'gone' that is not in the recipe set → incomplete.
    const result = projectPendingCostImpact(
      input({
        ingredients: [ingredient('a', { priceCents: 1000, pendingPriceCents: 1400 })],
        recipes: [recipe('r', null, ['a'])],
        menus: [
          menu('m', 3000, [
            { recipeId: 'r', quantity: 1 },
            { recipeId: 'gone', quantity: 1 },
          ]),
        ],
        focusIngredientIds: ['a'],
      }),
    );
    const m = result.affectedMenus[0]!;
    expect(m.currentCostCents).toBeNull();
    expect(m.projectedCostCents).toBeNull();
    expect(m.currentMarginPercent).toBeNull();
    expect(m.projectedMarginPercent).toBeNull();
  });

  it('does not affect a menu whose components are untouched', () => {
    const result = projectPendingCostImpact(
      input({
        ingredients: [
          ingredient('a', { priceCents: 1000, pendingPriceCents: 1400 }),
          ingredient('b'),
        ],
        recipes: [recipe('r1', null, ['a']), recipe('r2', null, ['b'])],
        menus: [menu('m', 3000, [{ recipeId: 'r2', quantity: 1 }])],
        focusIngredientIds: ['a'],
      }),
    );
    expect(result.affectedMenus).toHaveLength(0);
  });
});

describe('projectPendingCostImpact — ordering & empty', () => {
  it('returns an empty impact when nothing is focused', () => {
    const result = projectPendingCostImpact(
      input({
        ingredients: [ingredient('a', { priceCents: 1000, pendingPriceCents: 1400 })],
        recipes: [recipe('r', 2000, ['a'])],
        focusIngredientIds: [],
      }),
    );
    expect(result.changes).toHaveLength(0);
    expect(result.affectedRecipes).toHaveLength(0);
    expect(result.summary.recipesAffectedCount).toBe(0);
  });

  it('sorts affected recipes with the newly-at-risk one first', () => {
    // r1: 2000 price, already below (50% → 45%). r2: 3000 price, crosses (66.7% → 60%).
    const result = projectPendingCostImpact(
      input({
        ingredients: [
          ingredient('a', { priceCents: 1000, pendingPriceCents: 1100 }),
          ingredient('b', { priceCents: 1000, pendingPriceCents: 1200 }),
        ],
        recipes: [recipe('r1', 2000, ['a']), recipe('r2', 3000, ['b'])],
        focusIngredientIds: ['a', 'b'],
      }),
    );
    expect(result.affectedRecipes.map((r) => r.recipeId)).toEqual(['r2', 'r1']);
  });

  it('sorts changes with the biggest percent increase first', () => {
    const result = projectPendingCostImpact(
      input({
        ingredients: [
          ingredient('a', { priceCents: 1000, pendingPriceCents: 1100 }), // +10%
          ingredient('b', { priceCents: 1000, pendingPriceCents: 1500 }), // +50%
        ],
        focusIngredientIds: ['a', 'b'],
      }),
    );
    expect(result.changes.map((c) => c.ingredientId)).toEqual(['b', 'a']);
  });
});
