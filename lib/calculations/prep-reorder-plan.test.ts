import { describe, expect, it } from 'vitest';
import {
  buildPrepReorderPlan,
  displayCanonical,
  type PrepIngredientInput,
  type PrepRecipeInput,
  type PrepReorderPlanInput,
} from './prep-reorder-plan';

/**
 * Prep/Reorder Planner pure-logic tests (Sprint 7). Covers the acceptance §12 cases:
 * insufficient stock → reorder, missing yield, deleted ingredient, missing lines, and the
 * loss-adjusted scaling contract shared with the cost engine. MONEY-FREE throughout.
 */

function ingredient(over: Partial<PrepIngredientInput> = {}): PrepIngredientInput {
  return {
    id: 'ing-flour',
    name: 'Flour',
    dimension: 'weight',
    onHandCanonical: 10_000, // 10 kg
    lowStockThresholdCanonical: null,
    ...over,
  };
}

function recipe(over: Partial<PrepRecipeInput> = {}): PrepRecipeInput {
  return {
    id: 'r-bread',
    name: 'Bread',
    yieldPortions: 10,
    yieldPercentage: 100,
    lines: [{ ingredientId: 'ing-flour', dimension: 'weight', quantity: 5000 }], // 5 kg / 10 portions
    ...over,
  };
}

function input(over: Partial<PrepReorderPlanInput> = {}): PrepReorderPlanInput {
  return {
    demand: [{ recipeId: 'r-bread', expectedPortions: 10 }],
    recipes: [recipe()],
    ingredients: [ingredient()],
    ...over,
  };
}

describe('buildPrepReorderPlan', () => {
  it('scales a recipe to expected portions and aggregates ingredient demand', () => {
    const plan = buildPrepReorderPlan(
      input({ demand: [{ recipeId: 'r-bread', expectedPortions: 20 }] }),
    );
    // 20/10 batches = 2 → 5 kg × 2 = 10 kg required.
    expect(plan.prepSuggestions).toHaveLength(1);
    expect(plan.prepSuggestions[0]).toMatchObject({
      recipeId: 'r-bread',
      expectedPortions: 20,
      batches: 2,
      hasIssues: false,
    });
    expect(plan.hasPlan).toBe(true);
    // On-hand 10 kg exactly meets 10 kg required → no reorder, no low-stock (no threshold).
    expect(plan.reorderSuggestions).toHaveLength(0);
    expect(plan.lowStockWarnings).toHaveLength(0);
    expect(plan.issues).toHaveLength(0);
  });

  it('applies the loss fraction to the raw required amount (mirrors the cost engine)', () => {
    const plan = buildPrepReorderPlan(
      input({
        demand: [{ recipeId: 'r-bread', expectedPortions: 10 }],
        // 80% yield → need 5 kg / 0.8 = 6.25 kg raw for the base batch.
        recipes: [recipe({ yieldPercentage: 80 })],
        ingredients: [ingredient({ onHandCanonical: 0, lowStockThresholdCanonical: null })],
      }),
    );
    expect(plan.reorderSuggestions).toHaveLength(1);
    expect(plan.reorderSuggestions[0]!.requiredCanonical).toBeCloseTo(6250, 5);
    expect(plan.reorderSuggestions[0]!.shortfallCanonical).toBeCloseTo(6250, 5);
  });

  it('flags insufficient stock as a reorder shortfall', () => {
    const plan = buildPrepReorderPlan(
      input({
        demand: [{ recipeId: 'r-bread', expectedPortions: 30 }], // needs 15 kg
        ingredients: [ingredient({ onHandCanonical: 10_000 })], // only 10 kg
      }),
    );
    expect(plan.reorderSuggestions).toEqual([
      expect.objectContaining({
        ingredientId: 'ing-flour',
        requiredCanonical: 15_000,
        onHandCanonical: 10_000,
        shortfallCanonical: 5000,
      }),
    ]);
  });

  it('surfaces MISSING_YIELD and does not fabricate quantities for that recipe', () => {
    const plan = buildPrepReorderPlan(
      input({
        recipes: [recipe({ yieldPortions: 0 })],
        ingredients: [ingredient({ onHandCanonical: 0 })],
      }),
    );
    expect(plan.issues).toEqual([
      expect.objectContaining({ code: 'MISSING_YIELD', recipeId: 'r-bread' }),
    ]);
    // No ingredient demand derived → no reorder despite zero stock.
    expect(plan.reorderSuggestions).toHaveLength(0);
    expect(plan.prepSuggestions[0]!.hasIssues).toBe(true);
    expect(plan.prepSuggestions[0]!.batches).toBe(0);
  });

  it('surfaces MISSING_LINES for a recipe with no ingredient lines', () => {
    const plan = buildPrepReorderPlan(
      input({ recipes: [recipe({ lines: [] })] }),
    );
    expect(plan.issues).toEqual([
      expect.objectContaining({ code: 'MISSING_LINES', recipeId: 'r-bread' }),
    ]);
    expect(plan.reorderSuggestions).toHaveLength(0);
  });

  it('surfaces DELETED_INGREDIENT for a line pointing at a missing ingredient', () => {
    const plan = buildPrepReorderPlan(
      input({
        recipes: [
          recipe({
            lines: [
              { ingredientId: 'ing-flour', dimension: 'weight', quantity: 5000 },
              { ingredientId: 'ing-gone', dimension: 'weight', quantity: 1000 },
            ],
          }),
        ],
        ingredients: [ingredient()], // ing-gone is absent
      }),
    );
    expect(plan.issues).toEqual([
      expect.objectContaining({
        code: 'DELETED_INGREDIENT',
        recipeId: 'r-bread',
        ingredientId: 'ing-gone',
      }),
    ]);
    // The known ingredient is still planned; the missing one contributes nothing.
    expect(plan.reorderSuggestions).toHaveLength(0); // 10 kg on hand covers 5 kg
  });

  it('flags a low-stock warning caused by the plan, and one already under threshold', () => {
    const plan = buildPrepReorderPlan(
      input({
        demand: [{ recipeId: 'r-bread', expectedPortions: 10 }], // needs 5 kg flour
        recipes: [
          recipe({
            lines: [
              { ingredientId: 'ing-flour', dimension: 'weight', quantity: 5000 },
            ],
          }),
        ],
        ingredients: [
          // On-hand 6 kg, threshold 3 kg → projected 1 kg ≤ 3 kg (caused by plan).
          ingredient({ onHandCanonical: 6000, lowStockThresholdCanonical: 3000 }),
          // Undemanded but already at/under threshold → flagged, not plan-caused.
          ingredient({
            id: 'ing-salt',
            name: 'Salt',
            onHandCanonical: 200,
            lowStockThresholdCanonical: 500,
          }),
        ],
      }),
    );
    const flour = plan.lowStockWarnings.find((w) => w.ingredientId === 'ing-flour');
    const salt = plan.lowStockWarnings.find((w) => w.ingredientId === 'ing-salt');
    expect(flour).toMatchObject({
      projectedOnHandCanonical: 1000,
      causedByPlan: true,
    });
    expect(salt).toMatchObject({
      projectedOnHandCanonical: 200,
      causedByPlan: false,
    });
  });

  it('sums repeated demand lines for the same recipe', () => {
    const plan = buildPrepReorderPlan(
      input({
        demand: [
          { recipeId: 'r-bread', expectedPortions: 5 },
          { recipeId: 'r-bread', expectedPortions: 5 },
        ],
      }),
    );
    expect(plan.prepSuggestions[0]!.expectedPortions).toBe(10);
  });

  it('ignores non-positive or unknown demand lines', () => {
    const plan = buildPrepReorderPlan(
      input({
        demand: [
          { recipeId: 'r-bread', expectedPortions: 0 },
          { recipeId: 'r-unknown', expectedPortions: 10 },
        ],
      }),
    );
    expect(plan.prepSuggestions).toHaveLength(0);
    expect(plan.hasPlan).toBe(false);
  });

  it('displayCanonical rounds to whole units and guards non-finite', () => {
    expect(displayCanonical(6249.6)).toBe(6250);
    expect(displayCanonical(Infinity)).toBe(0);
  });
});
