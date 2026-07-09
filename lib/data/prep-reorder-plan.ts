import type { TenantClient } from '@/lib/db/tenant';
import { listIngredients } from '@/lib/data/ingredients';
import { loadActiveCatalogue } from '@/lib/data/active-catalogue';
import {
  buildPrepReorderPlan,
  type PrepReorderPlan,
} from '@/lib/calculations/prep-reorder-plan';

/**
 * Prep/Reorder Planner data loader (Sprint 7, AI margin roadmap). Org-scoped (RULE #1):
 * the shared `loadActiveCatalogue` read and `listIngredients` both filter
 * `organization_id`, and the caller runs it inside `withOrg` so RLS is the second layer.
 * MONEY-FREE end-to-end — the planner never reads or derives a price/cost/margin, so its
 * output is safe for kitchen users (plan §12 acceptance).
 *
 * It resolves the manager/kitchen's EXPECTED DEMAND (explicit per-recipe portions and/or a
 * menu × covers expansion) against the org's active catalogue and the inventory ledger,
 * then feeds the tested pure module. A menu contributes, per component recipe,
 * `componentQuantity × covers` portions. Selections for a trashed/cross-org recipe or menu
 * simply resolve to nothing (they are not in the active catalogue), never a fabricated
 * quantity.
 */

/** The demand a user assembles in the planner UI. */
export type PrepPlanSelection = {
  /** Explicit "make N portions of this recipe" lines. */
  recipes: { recipeId: string; portions: number }[];
  /** "Serve N covers of this menu" — expands to its component recipes' portions. */
  menus: { menuId: string; covers: number }[];
};

export async function loadPrepReorderPlan(
  db: TenantClient,
  organizationId: string,
  selection: PrepPlanSelection,
): Promise<PrepReorderPlan> {
  const [catalogue, ingredientRows] = await Promise.all([
    loadActiveCatalogue(db, organizationId),
    listIngredients(db, organizationId),
  ]);

  const recipeById = new Map(catalogue.recipes.map((r) => [r.id, r]));

  // ── Resolve demand: explicit recipe portions + menu × covers expansion. ──
  const demand: { recipeId: string; expectedPortions: number }[] = [];

  for (const line of selection.recipes) {
    if (!recipeById.has(line.recipeId)) continue; // trashed / cross-org → ignore
    demand.push({ recipeId: line.recipeId, expectedPortions: line.portions });
  }

  const menuById = new Map(catalogue.menus.map((m) => [m.id, m]));
  for (const sel of selection.menus) {
    if (!Number.isFinite(sel.covers) || sel.covers <= 0) continue;
    const menu = menuById.get(sel.menuId);
    if (!menu) continue;
    for (const component of menu.lines) {
      if (!recipeById.has(component.recipeId)) continue;
      demand.push({
        recipeId: component.recipeId,
        expectedPortions: component.quantity * sel.covers,
      });
    }
  }

  return buildPrepReorderPlan({
    demand,
    // Pass every active recipe so the pure module can look up any demanded one; it
    // only scales the recipes that actually carry demand.
    recipes: catalogue.recipes.map((r) => ({
      id: r.id,
      name: r.name,
      yieldPortions: r.yieldPortions,
      yieldPercentage: r.yieldPercentage,
      lines: r.lines.map((l) => ({
        ingredientId: l.ingredientId,
        dimension: l.dimension,
        quantity: l.quantity,
      })),
      componentsUnresolved: r.costUnresolved,
    })),
    ingredients: ingredientRows.map((i) => ({
      id: i.id,
      name: i.name,
      dimension: i.dimension,
      onHandCanonical: Number(i.stockQuantity),
      lowStockThresholdCanonical:
        i.lowStockThreshold == null ? null : Number(i.lowStockThreshold),
    })),
  });
}
