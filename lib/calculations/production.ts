/**
 * Production explosion + shortfall (Sprint 11a). Pure functions, no I/O.
 *
 * A production plan is `recipes × planned portions`. The "explosion" aggregates the
 * canonical ingredient requirement (the mise-en-place) by walking each recipe's
 * ingredient lines once (single-level — no nested recipes, D1) and scaling by the
 * planned portions, using the EXACT yield/loss convention of `recipeCost.ts`:
 *
 *   canonicalNeeded = line.quantity
 *                   × plannedQty
 *                   / recipe.yieldPortions
 *                   / (recipe.yieldPercentage / 100)
 *
 * Contributions are accumulated UNROUNDED across every recipe and rounded ONCE,
 * after aggregation, to 2 canonical decimals (the `numeric(12,2)` domain). The
 * result is a discriminated union so a partial/incomplete explosion can never be
 * mistaken for a final order list (D3/D5): an unavailable (trashed/missing) recipe,
 * invalid math, or an over-domain total all yield `complete: false`. This module
 * NEVER touches money — that is `componentCost` (manager-only).
 */

/** Largest value the canonical `numeric(12,2)` quantity domain can store. */
export const NUMERIC_12_2_MAX = 9_999_999_999.99;

/** Round a canonical quantity to the 2-decimal storage domain (single boundary). */
export function roundCanonical(value: number): number {
  return Math.round(value * 100) / 100;
}

/** One recipe in a production: its planned portions, availability, yield and lines. */
export type ProductionRecipeInput = {
  recipeId: string;
  /** Integer portions planned for this recipe (1..100000). */
  plannedQty: number;
  /** False when the recipe is trashed/missing → the explosion is incomplete. */
  available: boolean;
  yieldPortions: number;
  /** Usable yield after trim/loss as a percentage (100 = no loss). */
  yieldPercentage: number;
  /** This recipe's ingredient lines (canonical quantity per the recipe's batch). */
  lines: ProductionRecipeLine[];
};

export type ProductionRecipeLine = {
  ingredientId: string;
  /** Canonical amount used by the recipe batch: grams / millilitres / count. */
  quantity: number;
};

/** One aggregated canonical requirement across the whole production. */
export type IngredientRequirement = {
  ingredientId: string;
  /** Total canonical amount needed (rounded once, after aggregation). */
  quantityCanonical: number;
};

/**
 * The explosion result. `complete` is the discriminant: only a complete result
 * carries a final `requirements` list. An incomplete one exposes a clearly-labelled
 * `partialRequirements` PREVIEW (never an order list), the unavailable recipe ids,
 * and the reason. A production cannot be `planned` while incomplete (Sprint 11b
 * likewise refuses completion).
 */
export type ProductionExplosion =
  | {
      complete: true;
      requirements: IngredientRequirement[];
      unavailableRecipeIds: [];
    }
  | {
      complete: false;
      partialRequirements: IngredientRequirement[];
      unavailableRecipeIds: string[];
      reason: 'recipe_unavailable' | 'invalid_math' | 'overflow';
    };

function isPositiveInt(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Aggregate the canonical ingredient requirement for a production. Only ACTIVE
 * recipes contribute; an unavailable recipe makes the result incomplete (its lines
 * are never costed/exploded as if present). Structural problems (empty/duplicate
 * items, non-positive portions, invalid yield, non-finite/negative line quantities)
 * are `invalid_math`; a total beyond the `numeric(12,2)` domain is `overflow`. Both
 * are rejected, never clamped.
 */
export function explodeProduction(
  recipes: ProductionRecipeInput[],
): ProductionExplosion {
  // --- structural validation (applies to every item) ---
  if (recipes.length === 0) {
    return invalid('invalid_math');
  }
  const seen = new Set<string>();
  for (const recipe of recipes) {
    if (seen.has(recipe.recipeId)) return invalid('invalid_math');
    seen.add(recipe.recipeId);
    if (!isPositiveInt(recipe.plannedQty)) return invalid('invalid_math');
  }

  const unavailableRecipeIds = recipes
    .filter((r) => !r.available)
    .map((r) => r.recipeId)
    .sort();

  // --- aggregate UNROUNDED contributions from active recipes only ---
  const totals = new Map<string, number>();
  for (const recipe of recipes) {
    if (!recipe.available) continue;
    if (!isPositiveInt(recipe.yieldPortions)) return invalid('invalid_math');
    if (!Number.isFinite(recipe.yieldPercentage) || recipe.yieldPercentage <= 0) {
      return invalid('invalid_math');
    }
    const yieldFraction = recipe.yieldPercentage / 100;
    for (const line of recipe.lines) {
      if (!Number.isFinite(line.quantity) || line.quantity < 0) {
        return invalid('invalid_math');
      }
      const contribution =
        (line.quantity * recipe.plannedQty) / recipe.yieldPortions / yieldFraction;
      totals.set(
        line.ingredientId,
        (totals.get(line.ingredientId) ?? 0) + contribution,
      );
    }
  }

  // --- round ONCE after aggregation; reject non-finite/negative/over-domain ---
  const requirements: IngredientRequirement[] = [];
  for (const [ingredientId, raw] of totals) {
    if (!Number.isFinite(raw) || raw < 0) return invalid('invalid_math');
    const quantityCanonical = roundCanonical(raw);
    if (quantityCanonical > NUMERIC_12_2_MAX) return invalid('overflow');
    requirements.push({ ingredientId, quantityCanonical });
  }
  requirements.sort((a, b) => (a.ingredientId < b.ingredientId ? -1 : 1));

  if (unavailableRecipeIds.length > 0) {
    return {
      complete: false,
      partialRequirements: requirements,
      unavailableRecipeIds,
      reason: 'recipe_unavailable',
    };
  }

  return { complete: true, requirements, unavailableRecipeIds: [] };
}

function invalid(
  reason: 'invalid_math' | 'overflow',
): Extract<ProductionExplosion, { complete: false }> {
  return {
    complete: false,
    partialRequirements: [],
    unavailableRecipeIds: [],
    reason,
  };
}

/**
 * Graph-aware explosion (sub-recipes). Mirrors the write-time invariant's
 * ceiling: chains deeper than this are corrupted data and make the result
 * incomplete instead of recursing forever. Shared by cost/allergen resolvers.
 */
export const MAX_COMPONENT_DEPTH = 5;

/** One recipe node in the component graph, keyed by `recipeId` in the node map. */
export type RecipeTreeNode = {
  /** False when the recipe is trashed/missing → the explosion is incomplete. */
  available: boolean;
  yieldPortions: number;
  /** Usable yield after trim/loss as a percentage (100 = no loss). */
  yieldPercentage: number;
  /** Finished batch weight in grams; required (positive) to be USED as a component. */
  yieldWeightGrams: number | null;
  lines: ProductionRecipeLine[];
  /** Sub-recipe component lines: grams of the child's finished output per batch. */
  components: { componentRecipeId: string; quantityGrams: number }[];
};

/**
 * Aggregate the canonical RAW-ingredient requirement for `recipes × portions`,
 * traversing sub-recipe components to raw ingredients. Scaling contract
 * (sub-recipes plan, locked):
 *
 *   parentScaleAfterLoss = plannedQty / yieldPortions / yieldFraction
 *   direct line          → line.quantity × parentScaleAfterLoss
 *   component line       → finishedGramsNeeded = quantityGrams × parentScaleAfterLoss
 *                          childBatchScale = finishedGramsNeeded / child.yieldWeightGrams
 *                          recurse with childBatchScale / childYieldFraction
 *
 * Same complete-or-incomplete contract as `explodeProduction`: a trashed or
 * missing component is `recipe_unavailable` (its id listed); a component with
 * missing/invalid yield weight, a cycle, or a chain beyond MAX_COMPONENT_DEPTH
 * is `invalid_math`. Contributions accumulate UNROUNDED and round ONCE.
 */
export function explodeRecipeTree(
  items: { recipeId: string; plannedQty: number }[],
  nodes: Map<string, RecipeTreeNode>,
): ProductionExplosion {
  if (items.length === 0) return invalid('invalid_math');
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.recipeId)) return invalid('invalid_math');
    seen.add(item.recipeId);
    if (!isPositiveInt(item.plannedQty)) return invalid('invalid_math');
  }

  const totals = new Map<string, number>();
  const unavailable = new Set<string>();
  let corrupted = false;

  // Walk one recipe's batch at `scaleAfterLoss` (loss already applied), adding
  // its direct lines and recursing into components. Returns false on corrupted
  // graph data (bad yields, cycle, depth) — a hard `invalid_math`, not partial.
  const walk = (
    recipeId: string,
    scaleAfterLoss: number,
    depth: number,
    visited: Set<string>,
  ): boolean => {
    const node = nodes.get(recipeId);
    if (!node || !node.available) {
      unavailable.add(recipeId);
      return true; // recipe_unavailable is a partial-preview state, not corruption
    }
    for (const line of node.lines) {
      if (!Number.isFinite(line.quantity) || line.quantity < 0) return false;
      totals.set(
        line.ingredientId,
        (totals.get(line.ingredientId) ?? 0) + line.quantity * scaleAfterLoss,
      );
    }
    for (const component of node.components) {
      if (depth >= MAX_COMPONENT_DEPTH) return false;
      if (visited.has(component.componentRecipeId)) return false;
      if (
        !Number.isFinite(component.quantityGrams) ||
        component.quantityGrams <= 0
      ) {
        return false;
      }
      const child = nodes.get(component.componentRecipeId);
      if (!child || !child.available) {
        unavailable.add(component.componentRecipeId);
        continue;
      }
      if (
        child.yieldWeightGrams == null ||
        !Number.isFinite(child.yieldWeightGrams) ||
        child.yieldWeightGrams <= 0
      ) {
        return false;
      }
      if (
        !Number.isFinite(child.yieldPercentage) ||
        child.yieldPercentage <= 0
      ) {
        return false;
      }
      const childBatchScale =
        (component.quantityGrams * scaleAfterLoss) / child.yieldWeightGrams;
      const childScaleAfterLoss = childBatchScale / (child.yieldPercentage / 100);
      const nextVisited = new Set(visited);
      nextVisited.add(component.componentRecipeId);
      if (
        !walk(component.componentRecipeId, childScaleAfterLoss, depth + 1, nextVisited)
      ) {
        return false;
      }
    }
    return true;
  };

  for (const item of items) {
    const node = nodes.get(item.recipeId);
    if (!node || !node.available) {
      unavailable.add(item.recipeId);
      continue;
    }
    if (!isPositiveInt(node.yieldPortions)) return invalid('invalid_math');
    if (!Number.isFinite(node.yieldPercentage) || node.yieldPercentage <= 0) {
      return invalid('invalid_math');
    }
    const scaleAfterLoss =
      item.plannedQty / node.yieldPortions / (node.yieldPercentage / 100);
    if (!walk(item.recipeId, scaleAfterLoss, 0, new Set([item.recipeId]))) {
      corrupted = true;
      break;
    }
  }
  if (corrupted) return invalid('invalid_math');

  const requirements: IngredientRequirement[] = [];
  for (const [ingredientId, raw] of totals) {
    if (!Number.isFinite(raw) || raw < 0) return invalid('invalid_math');
    const quantityCanonical = roundCanonical(raw);
    if (quantityCanonical > NUMERIC_12_2_MAX) return invalid('overflow');
    requirements.push({ ingredientId, quantityCanonical });
  }
  requirements.sort((a, b) => (a.ingredientId < b.ingredientId ? -1 : 1));

  if (unavailable.size > 0) {
    return {
      complete: false,
      partialRequirements: requirements,
      unavailableRecipeIds: [...unavailable].sort(),
      reason: 'recipe_unavailable',
    };
  }
  return { complete: true, requirements, unavailableRecipeIds: [] };
}

/** One ingredient's stock position for a complete production requirement. */
export type ShortfallLine = {
  ingredientId: string;
  neededCanonical: number;
  onHandCanonical: number;
  /** max(0, needed − onHand), at the 2-decimal canonical boundary. */
  shortfallCanonical: number;
};

/**
 * The instantaneous shortfall of each requirement vs current on-hand stock:
 * `shortfall = max(0, needed − onHand)`. An ADVISORY only — it is NOT a reservation
 * (two plans can both see the same stock). Compute only from a COMPLETE explosion;
 * an incomplete one has no actionable requirement. On-hand defaults to 0 for an
 * ingredient absent from the map. Values are normalized to 2 canonical decimals.
 */
export function shortfallVsStock(
  requirements: IngredientRequirement[],
  onHandById: Map<string, number>,
): ShortfallLine[] {
  return requirements.map((req) => {
    const onHandCanonical = roundCanonical(onHandById.get(req.ingredientId) ?? 0);
    const neededCanonical = roundCanonical(req.quantityCanonical);
    const shortfallCanonical = roundCanonical(
      Math.max(0, neededCanonical - onHandCanonical),
    );
    return {
      ingredientId: req.ingredientId,
      neededCanonical,
      onHandCanonical,
      shortfallCanonical,
    };
  });
}
