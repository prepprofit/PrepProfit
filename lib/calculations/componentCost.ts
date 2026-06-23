/**
 * Generic component-cost sum (Sprint 11a, D10). Pure function, no I/O.
 *
 * Extracted from `menuCost` (lib/calculations/menu.ts) so Menus AND Production
 * share the exact same complete-or-null, safe-integer behaviour: a derived total
 * is `sum(costPerPortionCents × quantity)` across the components, but ONLY when
 * every component is available and the total is a finite, non-negative safe
 * integer. Any unavailable component (or a non-finite/negative/overflowing total)
 * yields an INCOMPLETE result that carries `costCents: null` — never a partial
 * sum, never a misleading 0 (D5). Money is integer cents throughout.
 *
 * `menuCost` is a thin adapter over this (keeping `recipeId`/`unavailableRecipeIds`
 * names), and Production calls it with `plannedQty` as the quantity.
 */

/** One component fed to {@link componentCost}: an id, its per-portion cost, a quantity. */
export type CostComponent = {
  /** Identifies the component so an unavailable one can be named in the result. */
  id: string;
  /** This component's current cost per portion (cents), or null if unavailable. */
  costPerPortionCents: number | null;
  /** How many portions of this component (integer ≥ 1). */
  quantity: number;
};

/**
 * The derived component cost. `complete` is the discriminant: only a complete
 * result carries a numeric `costCents`; an incomplete one names every unavailable
 * component id and carries `costCents: null`.
 */
export type ComponentCostResult =
  | { complete: true; costCents: number; unavailableIds: [] }
  | { complete: false; costCents: null; unavailableIds: string[] };

/**
 * Sum `costPerPortionCents × quantity` across the components — but ONLY when every
 * component is available and the total is a finite, non-negative safe integer. An
 * empty component set is defensively incomplete (a saved menu/production always has
 * ≥ 1 item; an empty input is never a valid "free" total).
 */
export function componentCost(components: CostComponent[]): ComponentCostResult {
  const unavailable: string[] = [];
  for (const component of components) {
    if (
      component.costPerPortionCents === null ||
      !Number.isFinite(component.costPerPortionCents) ||
      !Number.isInteger(component.quantity) ||
      component.quantity < 1
    ) {
      unavailable.push(component.id);
    }
  }

  if (components.length === 0 || unavailable.length > 0) {
    return { complete: false, costCents: null, unavailableIds: unavailable };
  }

  let total = 0;
  for (const component of components) {
    // costPerPortionCents is non-null here (no unavailable components).
    total += (component.costPerPortionCents as number) * component.quantity;
  }

  if (!Number.isSafeInteger(total) || total < 0) {
    return { complete: false, costCents: null, unavailableIds: [] };
  }

  return { complete: true, costCents: total, unavailableIds: [] };
}
