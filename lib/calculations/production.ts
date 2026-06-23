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
