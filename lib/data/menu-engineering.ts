import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { saleItems, sales } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { recipeCost } from '@/lib/calculations/recipeCost';
import { menuCost } from '@/lib/calculations/menu';
import { loadActiveCatalogue } from '@/lib/data/active-catalogue';
import {
  classifyMenuItems,
  type MenuEngineeringInputItem,
  type MenuEngineeringResult,
} from '@/lib/calculations/menu-engineering';

/**
 * Menu Engineering data loader (Sprint 5, Slice 5.2). Org-scoped (RULE #1): both the
 * shared `loadActiveCatalogue` read and the sales aggregation filter `organization_id`,
 * and the caller runs it inside `withOrg` so RLS is the second layer. Menu engineering
 * is FINANCIAL → manager-only at the page/action layer; this loader assumes the role
 * check already passed.
 *
 * It joins two things the pure classifier can't see: the org's CURRENT catalogue cost
 * (via the same engine the recipe editor uses — `recipeCost`/`menuCost`, so a recipe
 * with an unpriced ingredient or an incomplete menu resolves to a null cost, never a
 * flattered one) and the POSTED sale volume in the period (draft/void excluded). Only
 * items still in the active catalogue are classified — a sold-but-trashed recipe/menu
 * is no longer a menu item you can act on, so it's dropped. All money/classification
 * logic lives in the tested pure module; this stays a thin, org-scoped mapper.
 */

/** Inclusive close-date window, bare 'YYYY-MM-DD' (matches `sales.sale_date`). */
export type MenuEngineeringPeriod = { from: string; to: string };

export async function loadMenuEngineering(
  db: TenantClient,
  organizationId: string,
  period: MenuEngineeringPeriod,
): Promise<MenuEngineeringResult> {
  const catalogue = await loadActiveCatalogue(db, organizationId);

  // Current cost per recipe portion — null when any line's ingredient needs pricing
  // (the cost would be understated), mirroring the Profit Leak Detector's honesty.
  const needsPricingIngredientIds = new Set(
    catalogue.ingredients.filter((i) => i.needsPricing).map((i) => i.id),
  );
  const recipeCostPerPortion = new Map<string, number | null>();
  for (const recipe of catalogue.recipes) {
    const unpriced = recipe.lines.some((l) =>
      needsPricingIngredientIds.has(l.ingredientId),
    );
    const cost = recipeCost({
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
    });
    recipeCostPerPortion.set(recipe.id, unpriced ? null : cost.costPerPortionCents);
  }

  // Current menu cost — complete-or-null (an incomplete menu stays incomplete).
  const menuCostById = new Map<string, number | null>();
  for (const menu of catalogue.menus) {
    const cost = menuCost(
      menu.lines.map((line) => ({
        recipeId: line.recipeId,
        quantity: line.quantity,
        costPerPortionCents: recipeCostPerPortion.get(line.recipeId) ?? null,
      })),
    );
    menuCostById.set(menu.id, cost.complete ? cost.costCents : null);
  }

  // Posted-sale units per recipe/menu in the window. Join sale_items → sales to filter
  // by status + date; both tables are org-scoped. Ingredient-kind lines (raw resale,
  // not an engineered menu item) are excluded.
  const rows = await db
    .select({
      itemKind: saleItems.itemKind,
      recipeId: saleItems.itemRecipeId,
      menuId: saleItems.itemMenuId,
      units: sql<string>`sum(${saleItems.quantity})`,
    })
    .from(saleItems)
    .innerJoin(
      sales,
      and(
        eq(sales.id, saleItems.saleId),
        eq(sales.organizationId, organizationId),
      ),
    )
    .where(
      and(
        eq(saleItems.organizationId, organizationId),
        eq(sales.status, 'posted'),
        gte(sales.saleDate, period.from),
        lte(sales.saleDate, period.to),
        inArray(saleItems.itemKind, ['recipe', 'menu']),
      ),
    )
    .groupBy(saleItems.itemKind, saleItems.itemRecipeId, saleItems.itemMenuId);

  const recipeUnits = new Map<string, number>();
  const menuUnits = new Map<string, number>();
  for (const row of rows) {
    const units = Number(row.units);
    if (!Number.isFinite(units) || units <= 0) continue;
    if (row.itemKind === 'recipe' && row.recipeId) {
      recipeUnits.set(row.recipeId, (recipeUnits.get(row.recipeId) ?? 0) + units);
    } else if (row.itemKind === 'menu' && row.menuId) {
      menuUnits.set(row.menuId, (menuUnits.get(row.menuId) ?? 0) + units);
    }
  }

  const items: MenuEngineeringInputItem[] = [];
  for (const recipe of catalogue.recipes) {
    const units = recipeUnits.get(recipe.id);
    if (!units) continue; // menu engineering is about SOLD items
    items.push({
      kind: 'recipe',
      id: recipe.id,
      name: recipe.name,
      unitsSold: units,
      sellingPriceCents: recipe.sellingPriceCents,
      costCents: recipeCostPerPortion.get(recipe.id) ?? null,
    });
  }
  for (const menu of catalogue.menus) {
    const units = menuUnits.get(menu.id);
    if (!units) continue;
    items.push({
      kind: 'menu',
      id: menu.id,
      name: menu.name,
      unitsSold: units,
      sellingPriceCents: menu.sellingPriceCents,
      costCents: menuCostById.get(menu.id) ?? null,
    });
  }

  return classifyMenuItems(items);
}
