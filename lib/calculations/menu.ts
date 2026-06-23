import {
  ALLERGEN_ORDER,
  type AllergenSlug,
  type Presence,
} from '@/lib/allergens/catalog';
import { maxPresence } from '@/lib/calculations/allergens';
import type { RecipeAllergenRollup } from '@/lib/calculations/allergens';
import { componentCost } from '@/lib/calculations/componentCost';

/**
 * Menu / combo aggregation (Sprint 10). Pure functions, no I/O — mirror
 * `recipeCost`/`recipeAllergens`: a menu's cost and allergens DERIVE ON READ from
 * its component recipes and are never stored.
 *
 * The whole point is the INCOMPLETE state. A menu line whose recipe is
 * unavailable (trashed/missing → `costPerPortionCents = null`) must NEVER be
 * treated as a zero-cost component (D5): the entire menu cost becomes incomplete
 * and the manager DTO withholds price/food-cost/margin/traffic-light (rendered as
 * `—`, never a misleading `0%`). Money is integer cents throughout.
 */

/** One menu line as fed to {@link menuCost}: a recipe at a portion quantity. */
export type MenuCostLine = {
  recipeId: string;
  /** Portions of this recipe in the menu (integer ≥ 1). */
  quantity: number;
  /** This recipe's current cost per portion (cents), or null if unavailable. */
  costPerPortionCents: number | null;
};

/**
 * The menu's derived component cost. `complete` is the discriminant: only a
 * complete result carries a numeric `costCents`; an incomplete one names every
 * unavailable recipe and carries `costCents: null` (never a partial sum).
 */
export type MenuCostResult =
  | { complete: true; costCents: number; unavailableRecipeIds: [] }
  | { complete: false; costCents: null; unavailableRecipeIds: string[] };

/**
 * Sum `costPerPortionCents × quantity` across the lines — but ONLY when every line
 * is available and the total is a finite, non-negative safe integer. Any
 * unavailable line (or a non-finite/negative/overflowing total) yields an
 * incomplete result. An empty line set is defensively incomplete (a saved menu
 * always has ≥ 1 item; an empty input is never a valid "free" menu).
 *
 * Backwards-compatible adapter over the shared {@link componentCost} (Sprint 11a,
 * D10) — Menus and Production must agree on complete-or-null + safe-integer
 * behaviour. The only difference is naming: `recipeId`/`unavailableRecipeIds`.
 */
export function menuCost(lines: MenuCostLine[]): MenuCostResult {
  const result = componentCost(
    lines.map((line) => ({
      id: line.recipeId,
      costPerPortionCents: line.costPerPortionCents,
      quantity: line.quantity,
    })),
  );
  if (result.complete) {
    return { complete: true, costCents: result.costCents, unavailableRecipeIds: [] };
  }
  return {
    complete: false,
    costCents: null,
    unavailableRecipeIds: result.unavailableIds,
  };
}

/**
 * Food-cost % = cost / price × 100, one decimal. Returns null when the cost is
 * unavailable (incomplete menu) or the price is absent/non-positive — the UI then
 * renders `—`, never `0%`. A cost above the price (food-cost > 100%) is a real,
 * returned value (an underpriced menu), not capped.
 */
export function foodCostPercent(
  costCents: number | null,
  priceCents: number | null,
): number | null {
  if (costCents === null || priceCents === null) return null;
  if (!Number.isFinite(costCents) || !Number.isFinite(priceCents)) return null;
  if (priceCents <= 0) return null;
  return Math.round((costCents / priceCents) * 1000) / 10;
}

/** One allergen on a menu: the strongest presence across all component recipes. */
export type MenuAllergen = {
  allergen: AllergenSlug;
  presence: Presence;
};

/**
 * A menu's rolled-up allergens. The union of every component recipe's effective
 * allergens at their MAX presence, plus an OR of the components' unreviewed flags.
 * NEVER implies "allergen-free"; a trashed-but-retained component still contributes
 * (the caller must pass that recipe's rollup in).
 */
export type MenuAllergenRollup = {
  allergens: MenuAllergen[];
  hasUnreviewedIngredient: boolean;
};

/**
 * Merge component-recipe rollups into one menu rollup (pure). Union by allergen
 * keeping the strongest effective presence, sorted by the fixed catalog order so
 * UI/PDF are deterministic; `hasUnreviewedIngredient` is the OR across components.
 */
export function mergeMenuAllergens(
  rollups: RecipeAllergenRollup[],
): MenuAllergenRollup {
  const byAllergen = new Map<AllergenSlug, Presence>();
  let hasUnreviewedIngredient = false;

  for (const rollup of rollups) {
    if (rollup.hasUnreviewedIngredient) hasUnreviewedIngredient = true;
    for (const a of rollup.allergens) {
      const current = byAllergen.get(a.allergen);
      byAllergen.set(
        a.allergen,
        current ? maxPresence(current, a.effectivePresence) : a.effectivePresence,
      );
    }
  }

  const allergens: MenuAllergen[] = [...byAllergen.entries()]
    .map(([allergen, presence]) => ({ allergen, presence }))
    .sort((x, y) => ALLERGEN_ORDER[x.allergen] - ALLERGEN_ORDER[y.allergen]);

  return { allergens, hasUnreviewedIngredient };
}
