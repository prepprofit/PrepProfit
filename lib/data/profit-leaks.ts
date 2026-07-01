import type { TenantClient } from '@/lib/db/tenant';
import {
  detectProfitLeaks,
  type ProfitLeakFinding,
  type ProfitLeakInput,
} from '@/lib/calculations/profit-leaks';
import { loadActiveCatalogue } from '@/lib/data/active-catalogue';

/**
 * Profit Leak Detector data loader (Sprint 1, Slice 1.2). Org-scoped (RULE #1):
 * the shared `loadActiveCatalogue` read filters `organization_id` and the caller
 * runs it inside `withOrg` so RLS is the second layer. It maps the org's active
 * catalogue into the pure detector's input.
 *
 * No money or detection logic lives here: all findings come from the tested pure
 * module (`detectProfitLeaks`), so the loader stays a thin, org-scoped mapper.
 */
export async function loadProfitLeaks(
  db: TenantClient,
  organizationId: string,
): Promise<ProfitLeakFinding[]> {
  const catalogue = await loadActiveCatalogue(db, organizationId);

  const ingredients: ProfitLeakInput['ingredients'] = catalogue.ingredients;

  const recipes: ProfitLeakInput['recipes'] = catalogue.recipes.map((recipe) => ({
    id: recipe.id,
    name: recipe.name,
    sellingPriceCents: recipe.sellingPriceCents,
    cost: {
      yieldPortions: recipe.yieldPortions,
      yieldPercentage: recipe.yieldPercentage,
      laborCostCents: recipe.laborCostCents,
      energyCostCents: recipe.energyCostCents,
      packagingCostCents: recipe.packagingCostCents,
      lines: recipe.lines.map((l) => ({
        dimension: l.dimension,
        priceCents: l.priceCents,
        quantity: l.quantity,
      })),
    },
    ingredientIds: [...new Set(recipe.lines.map((l) => l.ingredientId))],
  }));

  const menus: ProfitLeakInput['menus'] = catalogue.menus;

  return detectProfitLeaks({ ingredients, recipes, menus });
}
