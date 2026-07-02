import type { Dimension } from '@/lib/units';

/**
 * Prep/Reorder Planner — pure fact derivation, no I/O, no AI, MONEY-FREE (Sprint 7,
 * AI margin roadmap).
 *
 * Turns EXPECTED DEMAND (how many portions of each recipe the kitchen expects to make)
 * into deterministic prep and reorder suggestions. The whole safety contract (plan §12,
 * CLAUDE.md §AI): every QUANTITY is computed HERE from recipe scaling + the stock ledger.
 * The AI layer that may run next only *formats* this fact set in prose — it never invents
 * an ingredient quantity, and this module never reads a price/cost/margin (so its output
 * is safe for kitchen users too — plan §12 acceptance "No money shown to kitchen users").
 *
 * Scaling mirrors the cost engine (lib/calculations/recipeCost.ts) so prep and cost tell
 * the same story: a recipe's lines are the canonical amounts (g / ml / count) used to make
 * its base `yieldPortions` at `yieldPercentage`. To make N portions the batch scales by
 * `N / yieldPortions`, and — exactly like `recipeCost` inflates ingredient cost by the loss
 * fraction — the RAW amount to buy/pull is divided by the yield fraction:
 *
 *   requiredCanonical(line) = line.quantity × (expectedPortions / yieldPortions) / yieldFraction
 *
 * Honesty rules (mirroring the Profit Leak Detector / Daily Close):
 *   - A recipe with a non-positive `yieldPortions` can't be scaled → its demand is NOT
 *     fabricated; it is set aside as a `MISSING_YIELD` issue and contributes no quantities.
 *   - A recipe with no lines is a `MISSING_LINES` issue (nothing to prep from).
 *   - A line pointing at an ingredient that is not in the active set (trashed/deleted/
 *     cross-set) is a `DELETED_INGREDIENT` issue — the line is surfaced, never silently
 *     dropped, and never counted toward a reorder.
 *
 * Quantities are canonical numbers (grams / millilitres / count). Nothing is rounded to
 * cents because there is no money here; canonical quantities are rounded to whole units at
 * the edge for display, but this module keeps full precision so aggregation is exact.
 */

/** One expected-demand line: make `expectedPortions` of `recipeId`. */
export type PrepDemandInput = {
  recipeId: string;
  /** Portions expected to be produced (finite, > 0; a non-positive is ignored). */
  expectedPortions: number;
};

/** A recipe line as the planner sees it — MONEY-FREE (no price). */
export type PrepRecipeLineInput = {
  ingredientId: string;
  dimension: Dimension;
  /** Canonical amount used per base batch (grams / millilitres / count). */
  quantity: number;
};

/** A recipe definition fed to the planner — MONEY-FREE. */
export type PrepRecipeInput = {
  id: string;
  name: string;
  /** Base batch portions the lines produce. Non-positive → MISSING_YIELD. */
  yieldPortions: number;
  /** Usable yield after trim/loss, percent (100 = no loss; ≤ 0 treated as 100). */
  yieldPercentage: number;
  lines: PrepRecipeLineInput[];
};

/** An active ingredient with its stock ledger snapshot — MONEY-FREE. */
export type PrepIngredientInput = {
  id: string;
  name: string;
  dimension: Dimension;
  /** Running canonical on-hand total from the inventory ledger. */
  onHandCanonical: number;
  /** Low-stock threshold (canonical), or null when none is set. */
  lowStockThresholdCanonical: number | null;
};

export type PrepReorderPlanInput = {
  demand: PrepDemandInput[];
  recipes: PrepRecipeInput[];
  ingredients: PrepIngredientInput[];
};

/** Why a demanded recipe could not be fully planned (surfaced, never hidden). */
export type PrepPlanIssueCode =
  // The recipe's yieldPortions is non-positive, so it can't be scaled.
  | 'MISSING_YIELD'
  // The recipe has no ingredient lines to prep from.
  | 'MISSING_LINES'
  // A line points at an ingredient not in the active set (trashed/deleted).
  | 'DELETED_INGREDIENT';

export type PrepPlanIssue = {
  code: PrepPlanIssueCode;
  recipeId: string;
  recipeName: string;
  /** Set only for DELETED_INGREDIENT — the missing ingredient id from the line. */
  ingredientId?: string;
};

/** One prep suggestion: make `expectedPortions` of a recipe. */
export type PrepSuggestion = {
  recipeId: string;
  recipeName: string;
  /** Total expected portions across all demand lines for this recipe. */
  expectedPortions: number;
  /** expectedPortions / yieldPortions (how many base batches), one decimal. */
  batches: number;
  /** True when this recipe also raised ≥1 issue (missing yield/lines/ingredient). */
  hasIssues: boolean;
};

/** One reorder suggestion: buy/pull the shortfall of an ingredient. */
export type ReorderSuggestion = {
  ingredientId: string;
  ingredientName: string;
  dimension: Dimension;
  /** Canonical amount the plan needs across every demanded recipe. */
  requiredCanonical: number;
  /** Canonical on-hand from the ledger. */
  onHandCanonical: number;
  /** required − onHand, only listed when > 0. */
  shortfallCanonical: number;
};

/** One low-stock warning: the projected on-hand dips at/under the threshold. */
export type LowStockWarning = {
  ingredientId: string;
  ingredientName: string;
  dimension: Dimension;
  onHandCanonical: number;
  thresholdCanonical: number;
  /** onHand − required (can be negative when the plan over-draws). */
  projectedOnHandCanonical: number;
  /** True when the plan itself pushes it under threshold (vs already under). */
  causedByPlan: boolean;
};

export type PrepReorderPlan = {
  prepSuggestions: PrepSuggestion[];
  reorderSuggestions: ReorderSuggestion[];
  lowStockWarnings: LowStockWarning[];
  issues: PrepPlanIssue[];
  /** True when there is at least one prep suggestion to act on. */
  hasPlan: boolean;
};

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Build the deterministic prep/reorder plan (pure). Demand lines for the same recipe are
 * summed; ingredient requirements are aggregated across every recipe; reorder + low-stock
 * are derived from the current ledger. Nothing is fabricated — un-scalable recipes and
 * unknown ingredients become surfaced issues, not silent quantities.
 */
export function buildPrepReorderPlan(
  input: PrepReorderPlanInput,
): PrepReorderPlan {
  const recipeById = new Map(input.recipes.map((r) => [r.id, r]));
  const ingredientById = new Map(input.ingredients.map((i) => [i.id, i]));

  // ── 1. Collapse demand to expected portions per recipe (ignore non-positive). ──
  const portionsByRecipe = new Map<string, number>();
  for (const line of input.demand) {
    if (!Number.isFinite(line.expectedPortions) || line.expectedPortions <= 0) {
      continue;
    }
    const recipe = recipeById.get(line.recipeId);
    if (!recipe) continue; // a demand line for a recipe we weren't given is ignored
    portionsByRecipe.set(
      line.recipeId,
      (portionsByRecipe.get(line.recipeId) ?? 0) + line.expectedPortions,
    );
  }

  const issues: PrepPlanIssue[] = [];
  const prepSuggestions: PrepSuggestion[] = [];
  // Aggregate canonical demand per ingredient across all scalable recipes.
  const requiredByIngredient = new Map<string, number>();

  // ── 2. Per demanded recipe: validate, scale, aggregate. ──
  for (const [recipeId, expectedPortions] of portionsByRecipe) {
    const recipe = recipeById.get(recipeId);
    if (!recipe) continue;

    let hasIssues = false;

    if (!Number.isFinite(recipe.yieldPortions) || recipe.yieldPortions <= 0) {
      issues.push({ code: 'MISSING_YIELD', recipeId, recipeName: recipe.name });
      hasIssues = true;
    }
    if (recipe.lines.length === 0) {
      issues.push({ code: 'MISSING_LINES', recipeId, recipeName: recipe.name });
      hasIssues = true;
    }

    const scalable = Number.isFinite(recipe.yieldPortions) && recipe.yieldPortions > 0;
    const yieldFraction =
      recipe.yieldPercentage > 0 ? recipe.yieldPercentage / 100 : 1;

    if (scalable) {
      const scale = expectedPortions / recipe.yieldPortions;
      for (const lineItem of recipe.lines) {
        if (!ingredientById.has(lineItem.ingredientId)) {
          issues.push({
            code: 'DELETED_INGREDIENT',
            recipeId,
            recipeName: recipe.name,
            ingredientId: lineItem.ingredientId,
          });
          hasIssues = true;
          continue;
        }
        const required = (lineItem.quantity * scale) / yieldFraction;
        if (!Number.isFinite(required) || required <= 0) continue;
        requiredByIngredient.set(
          lineItem.ingredientId,
          (requiredByIngredient.get(lineItem.ingredientId) ?? 0) + required,
        );
      }
    }

    prepSuggestions.push({
      recipeId,
      recipeName: recipe.name,
      expectedPortions,
      batches: scalable ? round1(expectedPortions / recipe.yieldPortions) : 0,
      hasIssues,
    });
  }

  // ── 3. Reorder + low-stock from the aggregated demand vs the ledger. ──
  const reorderSuggestions: ReorderSuggestion[] = [];
  const lowStockWarnings: LowStockWarning[] = [];

  // Consider every ingredient that is either demanded by the plan OR already under
  // its low-stock threshold — the latter is worth flagging even with no demand.
  const relevantIngredientIds = new Set<string>(requiredByIngredient.keys());
  for (const ing of input.ingredients) {
    if (
      ing.lowStockThresholdCanonical != null &&
      Number.isFinite(ing.lowStockThresholdCanonical) &&
      ing.onHandCanonical <= ing.lowStockThresholdCanonical
    ) {
      relevantIngredientIds.add(ing.id);
    }
  }

  for (const ingredientId of relevantIngredientIds) {
    const ing = ingredientById.get(ingredientId);
    if (!ing) continue;
    const required = requiredByIngredient.get(ingredientId) ?? 0;
    const projected = ing.onHandCanonical - required;

    if (required > ing.onHandCanonical) {
      reorderSuggestions.push({
        ingredientId,
        ingredientName: ing.name,
        dimension: ing.dimension,
        requiredCanonical: required,
        onHandCanonical: ing.onHandCanonical,
        shortfallCanonical: required - ing.onHandCanonical,
      });
    }

    const threshold = ing.lowStockThresholdCanonical;
    if (threshold != null && Number.isFinite(threshold) && projected <= threshold) {
      lowStockWarnings.push({
        ingredientId,
        ingredientName: ing.name,
        dimension: ing.dimension,
        onHandCanonical: ing.onHandCanonical,
        thresholdCanonical: threshold,
        projectedOnHandCanonical: projected,
        // Already under threshold before the plan drew anything down?
        causedByPlan: ing.onHandCanonical > threshold,
      });
    }
  }

  // ── 4. Deterministic ordering (name, then id) so output is stable. ──
  const byName = <T extends { ingredientName?: string; recipeName?: string; ingredientId?: string; recipeId?: string }>(
    a: T,
    b: T,
  ): number => {
    const an = a.ingredientName ?? a.recipeName ?? '';
    const bn = b.ingredientName ?? b.recipeName ?? '';
    const ai = a.ingredientId ?? a.recipeId ?? '';
    const bi = b.ingredientId ?? b.recipeId ?? '';
    return an.localeCompare(bn) || ai.localeCompare(bi);
  };

  prepSuggestions.sort(byName);
  reorderSuggestions.sort(
    (a, b) =>
      b.shortfallCanonical - a.shortfallCanonical || byName(a, b),
  );
  lowStockWarnings.sort(
    (a, b) =>
      a.projectedOnHandCanonical - b.projectedOnHandCanonical || byName(a, b),
  );
  issues.sort(
    (a, b) =>
      a.recipeName.localeCompare(b.recipeName) ||
      a.recipeId.localeCompare(b.recipeId) ||
      a.code.localeCompare(b.code) ||
      (a.ingredientId ?? '').localeCompare(b.ingredientId ?? ''),
  );

  return {
    prepSuggestions,
    reorderSuggestions,
    lowStockWarnings,
    issues,
    hasPlan: prepSuggestions.length > 0,
  };
}

/**
 * Round a canonical quantity to a whole unit for display (g / ml / count). Kept here so
 * the loader and UI present the same figure. Pure; never used inside aggregation.
 */
export function displayCanonical(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value);
}
