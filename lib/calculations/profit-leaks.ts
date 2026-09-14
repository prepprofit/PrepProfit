import { recipeCost, type RecipeCostInput } from './recipeCost';
import { marginPercent, suggestedPriceCents, MARGIN_THRESHOLDS } from './margin';
import { compositionCost, type DishComposition } from './dish';
import type { Dimension } from '@/lib/units';

/**
 * Profit Leak Detector — pure detection, no I/O, no AI (Sprint 1).
 *
 * The whole product thesis is "PrepProfit notices when your numbers stop making
 * sense" — so EVERY finding here is deterministic and derives from the SAME cost
 * engine the recipe editor and dashboard use (`recipeCost`, `marginPercent`,
 * `menuCost`). AI never produces these numbers; later sprints only *explain* them.
 *
 * Honesty rules that this module must never break (plan §6 acceptance):
 *   - A missing ingredient price (`needsPricing`) makes a recipe's cost UNTRUE
 *     (the column defaults to 0, so the computed margin would be flattered). Such
 *     a recipe NEVER emits a margin finding — it surfaces only as "needs pricing".
 *   - An incomplete menu (a trashed/missing component) stays incomplete: no menu
 *     margin finding, never a fake 0%.
 *   - A pending observed price is shown as PENDING impact, never as approved cost.
 *
 * Money is integer cents throughout. Inputs are normalized domain shapes (not DB
 * rows) so the loader does the mapping and this module stays unit-testable.
 */

export type ProfitLeakFindingType =
  | 'UNPRICED_INGREDIENT_IN_ACTIVE_RECIPE'
  | 'UNPRICED_INGREDIENT_IN_ACTIVE_MENU'
  | 'RECIPE_BELOW_TARGET_MARGIN'
  | 'MENU_BELOW_TARGET_MARGIN'
  | 'PENDING_PRICE_CHANGE_IMPACT';

export type ProfitLeakSeverity = 'info' | 'warning' | 'critical';

export type ProfitLeakFinding = {
  /** Stable de-dup key: type + entity + the price/cost version that defines it. */
  fingerprint: string;
  type: ProfitLeakFindingType;
  severity: ProfitLeakSeverity;
  entityType: 'ingredient' | 'recipe' | 'menu';
  entityId: string;
  entityName: string;
  /** Recipes/menus this finding touches (e.g. recipes that use an unpriced ing). */
  affectedEntityIds: string[];
  currentMarginPercent: number | null;
  targetMarginPercent: number | null;
  currentCostCents: number | null;
  pendingCostCents: number | null;
  suggestedPriceCents: number | null;
  reasonCode: string;
};

export type ProfitLeakIngredient = {
  id: string;
  name: string;
  priceCents: number;
  pendingPriceCents: number | null;
  needsPricing: boolean;
  /** Needed to cost a dish's direct ingredient lines; absent → those lines are unknown. */
  dimension?: Dimension;
};

export type ProfitLeakRecipe = {
  id: string;
  name: string;
  /** Per-portion selling price in cents, or null when the chef hasn't priced it. */
  sellingPriceCents: number | null;
  cost: RecipeCostInput;
  /** Distinct ingredient ids referenced by this recipe's active lines. */
  ingredientIds: string[];
  /**
   * True when the recipe's sub-recipe component tree could not be resolved —
   * its cost is UNTRUE (understated), so like `needsPricing` it must never
   * emit a margin finding.
   */
  costUnresolved?: boolean;
  /** Finished batch weight (g) — converts a dish's gram lines to portions. */
  yieldWeightGrams?: number | null;
};

/** A dish: recipe lines + direct ingredient lines; price per portion. */
export type ProfitLeakMenu = DishComposition & {
  id: string;
  name: string;
  sellingPriceCents: number | null;
};

export type ProfitLeakInput = {
  ingredients: ProfitLeakIngredient[];
  recipes: ProfitLeakRecipe[];
  menus: ProfitLeakMenu[];
  /** Defaults to the existing green threshold (65%). */
  targetMarginPercent?: number;
};

/** FNV-1a → 8-hex-char digest. Keeps the fingerprint compact and deterministic. */
function fingerprint(parts: (string | number | null)[]): string {
  let hash = 0x811c9dc5;
  const input = parts.map((p) => (p == null ? '∅' : String(p))).join('|');
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** A below-target margin is critical once it falls under the yellow (40%) band. */
function marginSeverity(marginPct: number): ProfitLeakSeverity {
  return marginPct < MARGIN_THRESHOLDS.yellow ? 'critical' : 'warning';
}

/**
 * Detect every deterministic profit leak in the org's active catalogue.
 *
 * Findings are returned sorted by severity (critical → warning → info) so the
 * dashboard card can take the top N without re-sorting.
 */
export function detectProfitLeaks(input: ProfitLeakInput): ProfitLeakFinding[] {
  const target = input.targetMarginPercent ?? MARGIN_THRESHOLDS.green;
  const findings: ProfitLeakFinding[] = [];

  const ingredientById = new Map<string, ProfitLeakIngredient>();
  for (const ing of input.ingredients) ingredientById.set(ing.id, ing);

  // Reverse indices: which active recipes/menus does each ingredient touch? Built
  // once so the unpriced + pending findings stay O(n) instead of re-scanning.
  const recipesByIngredient = new Map<string, string[]>();
  const menusByIngredient = new Map<string, string[]>();

  // Per-recipe derived state, reused by recipe margin findings AND menu costing.
  const recipeCostPerPortion = new Map<string, number | null>();

  for (const recipe of input.recipes) {
    const unpriced =
      recipe.ingredientIds.some(
        (id) => ingredientById.get(id)?.needsPricing === true,
      ) || recipe.costUnresolved === true;
    // An unpriced line means the cost is understated → never trust the margin.
    const cost = recipeCost(recipe.cost);
    recipeCostPerPortion.set(recipe.id, unpriced ? null : cost.costPerPortionCents);

    for (const id of recipe.ingredientIds) {
      const list = recipesByIngredient.get(id);
      if (list) list.push(recipe.id);
      else recipesByIngredient.set(id, [recipe.id]);
    }
  }

  const recipeById = new Map(input.recipes.map((r) => [r.id, r]));
  for (const menu of input.menus) {
    const ingredientIds = new Set<string>();
    for (const line of menu.recipeLines) {
      const recipe = recipeById.get(line.recipeId);
      if (recipe) for (const id of recipe.ingredientIds) ingredientIds.add(id);
    }
    for (const line of menu.ingredientLines) ingredientIds.add(line.ingredientId);
    for (const id of ingredientIds) {
      const list = menusByIngredient.get(id);
      if (list) list.push(menu.id);
      else menusByIngredient.set(id, [menu.id]);
    }
  }

  // ── Unpriced ingredients in active recipes / menus ──────────────────────────
  for (const ing of input.ingredients) {
    if (!ing.needsPricing) continue;

    const recipesUsing = recipesByIngredient.get(ing.id) ?? [];
    if (recipesUsing.length > 0) {
      findings.push({
        fingerprint: fingerprint(['UNPRICED_RECIPE', ing.id, recipesUsing.length]),
        type: 'UNPRICED_INGREDIENT_IN_ACTIVE_RECIPE',
        severity: 'warning',
        entityType: 'ingredient',
        entityId: ing.id,
        entityName: ing.name,
        affectedEntityIds: recipesUsing,
        currentMarginPercent: null,
        targetMarginPercent: null,
        currentCostCents: null,
        pendingCostCents: null,
        suggestedPriceCents: null,
        reasonCode: 'INGREDIENT_NEEDS_PRICING',
      });
    }

    const menusUsing = menusByIngredient.get(ing.id) ?? [];
    if (menusUsing.length > 0) {
      findings.push({
        fingerprint: fingerprint(['UNPRICED_MENU', ing.id, menusUsing.length]),
        type: 'UNPRICED_INGREDIENT_IN_ACTIVE_MENU',
        severity: 'warning',
        entityType: 'ingredient',
        entityId: ing.id,
        entityName: ing.name,
        affectedEntityIds: menusUsing,
        currentMarginPercent: null,
        targetMarginPercent: null,
        currentCostCents: null,
        pendingCostCents: null,
        suggestedPriceCents: null,
        reasonCode: 'INGREDIENT_NEEDS_PRICING',
      });
    }
  }

  // ── Recipes below the target margin ─────────────────────────────────────────
  for (const recipe of input.recipes) {
    const price = recipe.sellingPriceCents;
    if (price == null || price <= 0) continue; // can't compute a margin without a price
    const costPerPortion = recipeCostPerPortion.get(recipe.id);
    if (costPerPortion == null) continue; // unpriced ingredient → already flagged, margin untrue
    if (!Number.isFinite(costPerPortion)) continue; // never a finding off a non-finite cost

    const margin = marginPercent(costPerPortion, price);
    if (margin >= target) continue;

    findings.push({
      fingerprint: fingerprint(['RECIPE_MARGIN', recipe.id, costPerPortion, price]),
      type: 'RECIPE_BELOW_TARGET_MARGIN',
      severity: marginSeverity(margin),
      entityType: 'recipe',
      entityId: recipe.id,
      entityName: recipe.name,
      affectedEntityIds: [],
      currentMarginPercent: margin,
      targetMarginPercent: target,
      currentCostCents: costPerPortion,
      pendingCostCents: null,
      suggestedPriceCents: suggestedPriceCents(costPerPortion, target),
      reasonCode: 'BELOW_TARGET_MARGIN',
    });
  }

  // ── Menus below the target margin ───────────────────────────────────────────
  for (const menu of input.menus) {
    const price = menu.sellingPriceCents;
    if (price == null || price <= 0) continue;

    const cost = compositionCost(menu, {
      recipeCostPerPortion: (id) => recipeCostPerPortion.get(id) ?? null,
      recipeYield: (id) => {
        const recipe = recipeById.get(id);
        return recipe
          ? { yieldPortions: recipe.cost.yieldPortions, yieldWeightGrams: recipe.yieldWeightGrams ?? null }
          : null;
      },
      ingredient: (id) => {
        const ing = ingredientById.get(id);
        return ing?.dimension
          ? { dimension: ing.dimension, priceCents: ing.priceCents, needsPricing: ing.needsPricing }
          : null;
      },
    });
    const costPerPortion = cost.costPerPortionCents;
    if (costPerPortion === null) continue; // incomplete dish stays incomplete — never a fake margin

    const margin = marginPercent(costPerPortion, price);
    if (margin >= target) continue;

    findings.push({
      fingerprint: fingerprint(['MENU_MARGIN', menu.id, costPerPortion, price]),
      type: 'MENU_BELOW_TARGET_MARGIN',
      severity: marginSeverity(margin),
      entityType: 'menu',
      entityId: menu.id,
      entityName: menu.name,
      affectedEntityIds: [],
      currentMarginPercent: margin,
      targetMarginPercent: target,
      currentCostCents: costPerPortion,
      pendingCostCents: null,
      suggestedPriceCents: suggestedPriceCents(costPerPortion, target),
      reasonCode: 'BELOW_TARGET_MARGIN',
    });
  }

  // ── Pending price observations affecting active recipes / menus ─────────────
  // MVP placeholder: flag that a different cost is pending. The full projected
  // margin recompute (pending-cost impact mode) lands in Sprint 3.
  for (const ing of input.ingredients) {
    const pending = ing.pendingPriceCents;
    if (pending == null || pending === ing.priceCents) continue;

    const affected = [
      ...(recipesByIngredient.get(ing.id) ?? []),
      ...(menusByIngredient.get(ing.id) ?? []),
    ];
    if (affected.length === 0) continue;

    findings.push({
      fingerprint: fingerprint(['PENDING', ing.id, ing.priceCents, pending]),
      type: 'PENDING_PRICE_CHANGE_IMPACT',
      severity: 'info',
      entityType: 'ingredient',
      entityId: ing.id,
      entityName: ing.name,
      affectedEntityIds: affected,
      currentMarginPercent: null,
      targetMarginPercent: null,
      currentCostCents: ing.priceCents,
      pendingCostCents: pending,
      suggestedPriceCents: null,
      reasonCode: 'PENDING_PRICE_OBSERVED',
    });
  }

  const rank: Record<ProfitLeakSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
