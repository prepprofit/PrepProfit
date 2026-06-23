/**
 * Sale consumption explosion (Sprint 12a). Pure functions, no I/O.
 *
 * Posting a daily-close sale consumes the ingredients BEHIND the sold items. This
 * module maps a sale's lines → an aggregated per-ingredient canonical requirement,
 * REUSING the production explosion (lib/calculations/production.ts):
 *
 *  - a RECIPE line sells `units` portions of a recipe → it contributes `units`
 *    portions to that recipe's explosion;
 *  - a MENU line sells `units` of a menu → each component recipe contributes
 *    `units × componentQuantity` portions (the menu→recipe expansion);
 *  - an INGREDIENT line sells `units` of a raw ingredient at
 *    `ingredient_qty_canonical` stock per sold unit → it consumes
 *    `units × qtyCanonicalPerUnit` of that ingredient directly.
 *
 * The data layer resolves availability/yield/lines and SUMS the recipe portions
 * across every recipe + menu reference into ONE {@link SaleRecipeInput} per distinct
 * recipe (the production explosion rejects duplicate recipe ids). This module then
 * reuses `explodeProduction` for the recipe-derived requirement and aggregates the
 * direct ingredient lines separately, merging both into one per-ingredient total.
 *
 * Like the production explosion the result is a discriminated union so a partial /
 * incomplete consumption can never be mistaken for a final order list: a trashed or
 * missing source (recipe / menu / ingredient), invalid math, or an over-domain total
 * all yield `complete: false`. This module NEVER touches money — sales are revenue,
 * the tax math lives in lib/calculations/tax.ts.
 */

import {
  explodeProduction,
  roundCanonical,
  NUMERIC_12_2_MAX,
  type IngredientRequirement,
  type ProductionRecipeInput,
} from '@/lib/calculations/production';

/** A distinct recipe to explode: the SUMMED portions across all recipe + menu refs. */
export type SaleRecipeInput = ProductionRecipeInput;

/** One direct-ingredient consumption line: `units × qtyCanonicalPerUnit`. */
export type SaleIngredientLine = {
  ingredientId: string;
  /** Units sold (integer ≥ 1). */
  units: number;
  /** Canonical stock consumed per sold unit (numeric > 0). */
  qtyCanonicalPerUnit: number;
  /** False when the ingredient is trashed/missing → the consumption is incomplete. */
  available: boolean;
};

export type SaleConsumptionInput = {
  /** Distinct recipes (recipe lines + menu expansion folded into plannedQty). */
  recipes: SaleRecipeInput[];
  /** Direct raw-ingredient lines. */
  ingredientLines: SaleIngredientLine[];
  /**
   * Sources the resolver already knows are missing/trashed but that the recipe
   * explosion can't see — e.g. a trashed MENU (a menu is not a recipe). Their ids
   * surface in `unavailableSourceIds` so the post can refuse with a useful reason.
   */
  unavailableSourceIds?: string[];
};

/**
 * The consumption result. `complete` is the discriminant: only a complete result
 * carries the final aggregated `requirements`. An incomplete one names the
 * unavailable source ids and the reason (mirroring the production explosion), and is
 * never posted.
 */
export type SaleConsumption =
  | { complete: true; requirements: IngredientRequirement[] }
  | {
      complete: false;
      reason: 'source_unavailable' | 'invalid_math' | 'overflow';
      unavailableSourceIds: string[];
    };

function isPositiveInt(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Aggregate the canonical ingredient requirement for a posted sale. Reuses
 * `explodeProduction` for the recipe/menu-derived part (it handles unavailable
 * recipes, invalid math and over-domain overflow + the single post-aggregation
 * round), and aggregates the direct ingredient lines independently. The two rounded
 * contributions are then summed per ingredient and the total re-checked for the
 * `numeric(12,2)` domain. Any unavailable source (ingredient line, menu, or recipe)
 * makes the result incomplete — a trashed component is never silently dropped.
 */
export function explodeSaleConsumption(
  input: SaleConsumptionInput,
): SaleConsumption {
  // --- structural validation of the direct ingredient lines ---
  for (const line of input.ingredientLines) {
    if (!isPositiveInt(line.units)) return invalid('invalid_math');
    if (!Number.isFinite(line.qtyCanonicalPerUnit) || line.qtyCanonicalPerUnit <= 0) {
      return invalid('invalid_math');
    }
  }

  // --- recipe/menu-derived requirement (delegated to the production explosion) ---
  let recipeRequirements: IngredientRequirement[] = [];
  if (input.recipes.length > 0) {
    const explosion = explodeProduction(input.recipes);
    if (!explosion.complete) {
      if (explosion.reason === 'recipe_unavailable') {
        return {
          complete: false,
          reason: 'source_unavailable',
          unavailableSourceIds: dedupeSort([
            ...(input.unavailableSourceIds ?? []),
            ...explosion.unavailableRecipeIds,
          ]),
        };
      }
      // invalid_math / overflow take priority and carry no unavailable ids.
      return invalid(explosion.reason);
    }
    recipeRequirements = explosion.requirements;
  }

  // --- any other unavailable source (trashed menu, trashed direct ingredient) ---
  const unavailable = [
    ...(input.unavailableSourceIds ?? []),
    ...input.ingredientLines.filter((l) => !l.available).map((l) => l.ingredientId),
  ];
  if (unavailable.length > 0) {
    return {
      complete: false,
      reason: 'source_unavailable',
      unavailableSourceIds: dedupeSort(unavailable),
    };
  }

  // --- merge recipe requirements + direct ingredient lines into one total ---
  const totals = new Map<string, number>();
  for (const req of recipeRequirements) {
    totals.set(req.ingredientId, (totals.get(req.ingredientId) ?? 0) + req.quantityCanonical);
  }
  // Direct lines: aggregate UNROUNDED across lines for the same ingredient.
  const directTotals = new Map<string, number>();
  for (const line of input.ingredientLines) {
    directTotals.set(
      line.ingredientId,
      (directTotals.get(line.ingredientId) ?? 0) + line.units * line.qtyCanonicalPerUnit,
    );
  }
  for (const [ingredientId, raw] of directTotals) {
    totals.set(ingredientId, (totals.get(ingredientId) ?? 0) + roundCanonical(raw));
  }

  const requirements: IngredientRequirement[] = [];
  for (const [ingredientId, raw] of totals) {
    if (!Number.isFinite(raw) || raw < 0) return invalid('invalid_math');
    const quantityCanonical = roundCanonical(raw);
    if (quantityCanonical > NUMERIC_12_2_MAX) return invalid('overflow');
    requirements.push({ ingredientId, quantityCanonical });
  }
  requirements.sort((a, b) => (a.ingredientId < b.ingredientId ? -1 : 1));

  return { complete: true, requirements };
}

function invalid(
  reason: 'invalid_math' | 'overflow',
): Extract<SaleConsumption, { complete: false }> {
  return { complete: false, reason, unavailableSourceIds: [] };
}

function dedupeSort(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}
