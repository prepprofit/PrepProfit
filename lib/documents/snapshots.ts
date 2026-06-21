import type { Ingredient, Recipe } from '@/lib/db/schema';
import type { Dimension } from '@/lib/units';

/**
 * Pure snapshot primitives (Sprint F3, Scope A).
 *
 * A non-draft document (purchase order, sale, production — Sprints 7/8/11/12) must
 * freeze the masters it depends on at the draft → issued/post transition, so the
 * historical document never changes when the live master is later edited or purged
 * (the same pattern `invoices` already uses for its customer snapshot — see
 * `docs/document-snapshot-policy.md`). These helpers turn an EXISTING master row
 * into the flat, frozen line-snapshot fields a document stores.
 *
 * They are pure (no I/O): the caller loads the master inside the issue/post
 * transaction+lock and passes it here. A snapshot is NEVER built from client input.
 *
 * Each helper takes a narrow `Pick`, not the whole row, so a caller can snapshot a
 * partially-loaded master and so the contract is explicit about which fields freeze.
 *
 * NOTE: `supplierSnapshot` is intentionally NOT here — the `suppliers` table does
 * not exist until Sprint 7, so it lands there alongside the supplier/PO schema.
 */

export type IngredientLineSnapshot = {
  ingredientName: string;
  /**
   * Approved cost per priced (canonical) unit at capture — per kg / litre / piece,
   * integer cents. Named *cost*, not *price*: a future sale/PO line may carry BOTH
   * a purchase cost AND a selling price, so the cost snapshot must be unambiguous.
   */
  unitCostCents: number;
  dimension: Dimension;
};

/**
 * Freezes an ingredient into a document line snapshot. `priceCents` is the
 * ingredient's approved cost per canonical unit (CLAUDE.md: weight → per kg,
 * volume → per litre, count → per piece) and becomes the line's `unitCostCents`.
 */
export function ingredientLineSnapshot(
  ing: Pick<Ingredient, 'name' | 'priceCents' | 'dimension'>,
): IngredientLineSnapshot {
  return {
    ingredientName: ing.name,
    unitCostCents: ing.priceCents,
    dimension: ing.dimension,
  };
}

export type RecipeLineSnapshot = {
  recipeName: string;
  /** The single portion cost (integer cents) the document used at capture. */
  portionCostCents: number;
};

/**
 * Freezes a recipe into a document line snapshot. The portion cost is DERIVED on
 * read from the recipe's ingredient lines + hidden costs (no stored cost column),
 * so the caller computes it inside the issue/post transaction and passes the single
 * number to freeze — the snapshot keeps ONLY that `portionCostCents`.
 */
export function recipeLineSnapshot(
  recipe: Pick<Recipe, 'name'>,
  portionCostCents: number,
): RecipeLineSnapshot {
  return {
    recipeName: recipe.name,
    portionCostCents,
  };
}
