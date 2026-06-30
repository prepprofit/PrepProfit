import { describe, expect, it } from 'vitest';
import {
  detectProfitLeaks,
  type ProfitLeakIngredient,
  type ProfitLeakInput,
  type ProfitLeakMenu,
  type ProfitLeakRecipe,
} from './profit-leaks';

/**
 * A recipe with a single 1 kg weight line priced per the given ingredient price.
 * With yieldPortions = 1 and no loss/hidden costs, costPerPortion == priceCents.
 * So `ingredientPriceCents: 1000` ⇒ cost per portion = 1000c (€10).
 */
function recipe(
  id: string,
  sellingPriceCents: number | null,
  ingredientPriceCents: number,
  ingredientIds: string[] = [`ing-${id}`],
): ProfitLeakRecipe {
  return {
    id,
    name: `Recipe ${id}`,
    sellingPriceCents,
    cost: {
      yieldPortions: 1,
      yieldPercentage: 100,
      laborCostCents: 0,
      energyCostCents: 0,
      packagingCostCents: 0,
      lines: [{ dimension: 'weight', priceCents: ingredientPriceCents, quantity: 1000 }],
    },
    ingredientIds,
  };
}

function ingredient(
  id: string,
  overrides: Partial<ProfitLeakIngredient> = {},
): ProfitLeakIngredient {
  return {
    id,
    name: `Ingredient ${id}`,
    priceCents: 1000,
    pendingPriceCents: null,
    needsPricing: false,
    ...overrides,
  };
}

function input(partial: Partial<ProfitLeakInput>): ProfitLeakInput {
  return {
    ingredients: partial.ingredients ?? [],
    recipes: partial.recipes ?? [],
    menus: partial.menus ?? [],
    targetMarginPercent: partial.targetMarginPercent,
  };
}

describe('detectProfitLeaks — recipe margin', () => {
  it('flags a recipe below the 65% target as a warning with a suggested price', () => {
    // cost 1000, price 2000 → margin 50% (< 65, ≥ 40 → warning).
    const findings = detectProfitLeaks(
      input({ recipes: [recipe('a', 2000, 1000)] }),
    );
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.type).toBe('RECIPE_BELOW_TARGET_MARGIN');
    expect(f.severity).toBe('warning');
    expect(f.entityType).toBe('recipe');
    expect(f.entityId).toBe('a');
    expect(f.currentMarginPercent).toBe(50);
    expect(f.targetMarginPercent).toBe(65);
    expect(f.currentCostCents).toBe(1000);
    // round(1000 / (1 - 0.65)) = round(2857.14) = 2857
    expect(f.suggestedPriceCents).toBe(2857);
  });

  it('escalates to critical below the 40% yellow band', () => {
    // cost 1000, price 1200 → margin 16.7% (< 40 → critical).
    const f = detectProfitLeaks(input({ recipes: [recipe('a', 1200, 1000)] }))[0]!;
    expect(f.severity).toBe('critical');
  });

  it('does not flag a recipe at or above target', () => {
    // cost 1000, price 3000 → margin 66.7% (≥ 65).
    expect(detectProfitLeaks(input({ recipes: [recipe('a', 3000, 1000)] }))).toEqual([]);
  });

  it('cannot compute a margin without a selling price (null or zero)', () => {
    expect(detectProfitLeaks(input({ recipes: [recipe('a', null, 1000)] }))).toEqual([]);
    expect(detectProfitLeaks(input({ recipes: [recipe('b', 0, 1000)] }))).toEqual([]);
  });

  it('respects a custom target margin', () => {
    // cost 1000, price 3000 → margin 66.7%. Above 65 (no finding) but below 80.
    expect(
      detectProfitLeaks(input({ recipes: [recipe('a', 3000, 1000)], targetMarginPercent: 80 })),
    ).toHaveLength(1);
  });
});

describe('detectProfitLeaks — unpriced ingredients (honesty)', () => {
  it('flags an unpriced ingredient used in an active recipe and suppresses its margin', () => {
    // The ingredient needs pricing (price defaults to 0), so the recipe margin
    // would be flattered — it must NOT produce a margin finding, only "needs pricing".
    const findings = detectProfitLeaks(
      input({
        ingredients: [ingredient('ing-a', { needsPricing: true, priceCents: 0 })],
        recipes: [recipe('a', 2000, 0, ['ing-a'])],
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe('UNPRICED_INGREDIENT_IN_ACTIVE_RECIPE');
    expect(findings[0]!.entityType).toBe('ingredient');
    expect(findings[0]!.entityId).toBe('ing-a');
    expect(findings[0]!.affectedEntityIds).toEqual(['a']);
    expect(findings.some((f) => f.type === 'RECIPE_BELOW_TARGET_MARGIN')).toBe(false);
  });

  it('flags an unpriced ingredient reaching a menu through its component recipe', () => {
    const findings = detectProfitLeaks(
      input({
        ingredients: [ingredient('ing-a', { needsPricing: true, priceCents: 0 })],
        recipes: [recipe('a', 2000, 0, ['ing-a'])],
        menus: [{ id: 'm1', name: 'Combo', sellingPriceCents: 3000, lines: [{ recipeId: 'a', quantity: 1 }] }],
      }),
    );
    const menuLeak = findings.find((f) => f.type === 'UNPRICED_INGREDIENT_IN_ACTIVE_MENU');
    expect(menuLeak).toBeDefined();
    expect(menuLeak?.affectedEntityIds).toEqual(['m1']);
  });

  it('ignores an unpriced ingredient that no active recipe or menu uses', () => {
    expect(
      detectProfitLeaks(
        input({ ingredients: [ingredient('orphan', { needsPricing: true, priceCents: 0 })] }),
      ),
    ).toEqual([]);
  });
});

describe('detectProfitLeaks — menu margin', () => {
  const ings = [ingredient('ing-a'), ingredient('ing-b')];

  it('flags a complete menu below target', () => {
    // component cost 1000 × 1 = 1000, menu price 1500 → margin 33.3% (critical).
    const findings = detectProfitLeaks(
      input({
        ingredients: ings,
        recipes: [recipe('a', null, 1000, ['ing-a'])],
        menus: [{ id: 'm1', name: 'Combo', sellingPriceCents: 1500, lines: [{ recipeId: 'a', quantity: 1 }] }],
      }),
    );
    const menuFinding = findings.find((f) => f.type === 'MENU_BELOW_TARGET_MARGIN');
    expect(menuFinding).toBeDefined();
    expect(menuFinding?.entityId).toBe('m1');
    expect(menuFinding?.currentCostCents).toBe(1000);
    expect(menuFinding?.severity).toBe('critical');
  });

  it('keeps an incomplete menu incomplete when a component recipe is missing', () => {
    const menu: ProfitLeakMenu = {
      id: 'm1',
      name: 'Combo',
      sellingPriceCents: 1500,
      lines: [{ recipeId: 'ghost', quantity: 1 }],
    };
    expect(detectProfitLeaks(input({ menus: [menu] }))).toEqual([]);
  });

  it('keeps a menu incomplete when a component recipe has an unpriced ingredient', () => {
    const findings = detectProfitLeaks(
      input({
        ingredients: [ingredient('ing-a', { needsPricing: true, priceCents: 0 })],
        recipes: [recipe('a', null, 0, ['ing-a'])],
        menus: [{ id: 'm1', name: 'Combo', sellingPriceCents: 1500, lines: [{ recipeId: 'a', quantity: 1 }] }],
      }),
    );
    // No menu margin finding (cost untrue), but the unpriced ingredient still surfaces.
    expect(findings.some((f) => f.type === 'MENU_BELOW_TARGET_MARGIN')).toBe(false);
    expect(findings.some((f) => f.type === 'UNPRICED_INGREDIENT_IN_ACTIVE_MENU')).toBe(true);
  });
});

describe('detectProfitLeaks — pending price impact', () => {
  it('flags a pending price that differs from the approved price', () => {
    const findings = detectProfitLeaks(
      input({
        ingredients: [ingredient('ing-a', { priceCents: 820, pendingPriceCents: 970 })],
        recipes: [recipe('a', null, 820, ['ing-a'])],
      }),
    );
    const f = findings.find((x) => x.type === 'PENDING_PRICE_CHANGE_IMPACT');
    expect(f).toBeDefined();
    expect(f?.severity).toBe('info');
    expect(f?.currentCostCents).toBe(820);
    expect(f?.pendingCostCents).toBe(970);
    expect(f?.affectedEntityIds).toEqual(['a']);
  });

  it('does not flag a pending price equal to the approved price, or a null pending', () => {
    expect(
      detectProfitLeaks(
        input({
          ingredients: [ingredient('ing-a', { priceCents: 820, pendingPriceCents: 820 })],
          recipes: [recipe('a', null, 820, ['ing-a'])],
        }),
      ),
    ).toEqual([]);
    expect(
      detectProfitLeaks(
        input({
          ingredients: [ingredient('ing-b', { priceCents: 820, pendingPriceCents: null })],
          recipes: [recipe('b', null, 820, ['ing-b'])],
        }),
      ),
    ).toEqual([]);
  });

  it('ignores a pending price on an ingredient no active recipe or menu uses', () => {
    expect(
      detectProfitLeaks(
        input({ ingredients: [ingredient('orphan', { priceCents: 820, pendingPriceCents: 970 })] }),
      ),
    ).toEqual([]);
  });
});

describe('detectProfitLeaks — ordering, edges and fingerprints', () => {
  it('returns nothing for an empty catalogue', () => {
    expect(detectProfitLeaks(input({}))).toEqual([]);
  });

  it('sorts findings critical → warning → info', () => {
    const findings = detectProfitLeaks(
      input({
        ingredients: [
          ingredient('ing-warn', { needsPricing: true, priceCents: 0 }),
          ingredient('ing-info', { priceCents: 820, pendingPriceCents: 970 }),
        ],
        recipes: [
          recipe('crit', 1200, 1000, ['ing-crit']), // margin 16.7% → critical
          recipe('warn', null, 0, ['ing-warn']), // unpriced → warning
          recipe('info', null, 820, ['ing-info']), // pending → info
        ],
      }),
    );
    const severities = findings.map((f) => f.severity);
    const rank = { critical: 0, warning: 1, info: 2 } as const;
    const sorted = [...severities].sort((a, b) => rank[a] - rank[b]);
    expect(severities).toEqual(sorted);
  });

  it('produces a stable fingerprint that changes when the cost/price version changes', () => {
    const a = detectProfitLeaks(input({ recipes: [recipe('a', 2000, 1000)] }))[0]!;
    const b = detectProfitLeaks(input({ recipes: [recipe('a', 2000, 1000)] }))[0]!;
    const c = detectProfitLeaks(input({ recipes: [recipe('a', 2100, 1000)] }))[0]!;
    expect(a.fingerprint).toBe(b.fingerprint); // same inputs → same key
    expect(a.fingerprint).not.toBe(c.fingerprint); // price moved → new key
  });

  it('does not crash or emit a finding on a non-finite recipe cost', () => {
    const broken = recipe('a', 2000, Number.POSITIVE_INFINITY);
    expect(
      detectProfitLeaks(input({ recipes: [broken] })).some(
        (f) => f.type === 'RECIPE_BELOW_TARGET_MARGIN',
      ),
    ).toBe(false);
  });

  it('handles large values without overflow surprises', () => {
    // cost 1e9 c, price 1.2e9 → margin 16.7% (critical), suggested price finite.
    const f = detectProfitLeaks(
      input({ recipes: [recipe('a', 1_200_000_000, 1_000_000_000)] }),
    )[0]!;
    expect(f.type).toBe('RECIPE_BELOW_TARGET_MARGIN');
    expect(Number.isFinite(f.suggestedPriceCents as number)).toBe(true);
  });
});
