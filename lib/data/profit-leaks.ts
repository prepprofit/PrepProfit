import { and, asc, eq, inArray } from 'drizzle-orm';
import { menuItems } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import {
  detectProfitLeaks,
  type ProfitLeakFinding,
  type ProfitLeakInput,
} from '@/lib/calculations/profit-leaks';
import { listRecipesWithLines } from '@/lib/data/recipes';
import { listIngredients } from '@/lib/data/ingredients';
import { listMenus } from '@/lib/data/menus';

/**
 * Profit Leak Detector data loader (Sprint 1, Slice 1.2). Org-scoped (RULE #1):
 * every read filters `organization_id` and the caller runs it inside `withOrg`
 * so RLS is the second layer. It assembles the active catalogue — active recipes
 * with their lines, active ingredients (the only rows carrying pricing state),
 * and active menus with their component lines — into the pure detector's input.
 *
 * No money or detection logic lives here: all findings come from the tested pure
 * module (`detectProfitLeaks`), so the loader stays a thin, org-scoped mapper.
 * The component reaches `menu_items` directly (one extra org-scoped query) rather
 * than the manager menu loader, because the detector recomputes menu cost itself.
 */
export async function loadProfitLeaks(
  db: TenantClient,
  organizationId: string,
): Promise<ProfitLeakFinding[]> {
  const [recipesWithLines, ingredientRows, menuRows] = await Promise.all([
    listRecipesWithLines(db, organizationId),
    listIngredients(db, organizationId),
    listMenus(db, organizationId),
  ]);

  const menuItemRows =
    menuRows.length === 0
      ? []
      : await db
          .select({
            menuId: menuItems.menuId,
            recipeId: menuItems.recipeId,
            quantity: menuItems.quantity,
            sortOrder: menuItems.sortOrder,
          })
          .from(menuItems)
          .where(
            and(
              eq(menuItems.organizationId, organizationId),
              inArray(
                menuItems.menuId,
                menuRows.map((m) => m.id),
              ),
            ),
          )
          .orderBy(asc(menuItems.menuId), asc(menuItems.sortOrder));

  const ingredients: ProfitLeakInput['ingredients'] = ingredientRows.map((i) => ({
    id: i.id,
    name: i.name,
    priceCents: i.priceCents,
    pendingPriceCents: i.pendingPriceCents,
    needsPricing: i.needsPricing,
  }));

  const recipes: ProfitLeakInput['recipes'] = recipesWithLines.map(
    ({ recipe, lines }) => ({
      id: recipe.id,
      name: recipe.name,
      sellingPriceCents: recipe.sellingPriceCents,
      cost: {
        yieldPortions: recipe.yieldPortions,
        yieldPercentage: recipe.yieldPercentage,
        laborCostCents: recipe.laborCostCents,
        energyCostCents: recipe.energyCostCents,
        packagingCostCents: recipe.packagingCostCents,
        lines: lines.map((l) => ({
          dimension: l.ingredient.dimension,
          priceCents: l.ingredient.priceCents,
          quantity: l.quantity,
        })),
      },
      ingredientIds: [...new Set(lines.map((l) => l.ingredientId))],
    }),
  );

  const linesByMenu = new Map<string, { recipeId: string; quantity: number }[]>();
  for (const row of menuItemRows) {
    const line = { recipeId: row.recipeId, quantity: row.quantity };
    const existing = linesByMenu.get(row.menuId);
    if (existing) existing.push(line);
    else linesByMenu.set(row.menuId, [line]);
  }

  const menus: ProfitLeakInput['menus'] = menuRows.map((m) => ({
    id: m.id,
    name: m.name,
    sellingPriceCents: m.sellingPriceCents,
    lines: linesByMenu.get(m.id) ?? [],
  }));

  return detectProfitLeaks({ ingredients, recipes, menus });
}
