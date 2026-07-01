import { and, asc, eq, inArray } from 'drizzle-orm';
import { menuItems } from '@/lib/db/schema';
import type { Dimension } from '@/lib/units';
import type { TenantClient } from '@/lib/db/tenant';
import { listRecipesWithLines } from '@/lib/data/recipes';
import { listIngredients } from '@/lib/data/ingredients';
import { listMenus } from '@/lib/data/menus';

/**
 * Active-catalogue reader shared by the Profit Leak Detector (Sprint 1) and the
 * Invoice-to-Profit Impact loop (Sprint 3). ALWAYS org-scoped (RULE #1); the
 * caller runs it inside `withOrg` so RLS is the second layer.
 *
 * It assembles the org's whole active catalogue — active recipes with their lines
 * (the ONLY rows carrying pricing state are the ingredients), active ingredients,
 * and active menus with their component lines — into normalized domain shapes.
 * No money or detection logic lives here: consumers feed these shapes to their own
 * tested pure module, so this stays a thin, org-scoped mapper.
 */

export type CatalogueIngredient = {
  id: string;
  name: string;
  priceCents: number;
  pendingPriceCents: number | null;
  needsPricing: boolean;
};

export type CatalogueRecipeLine = {
  ingredientId: string;
  dimension: Dimension;
  /** Ingredient's approved price per priced unit (per kg / litre / piece), cents. */
  priceCents: number;
  /** Canonical amount used: grams (weight), millilitres (volume), or count. */
  quantity: number;
};

export type CatalogueRecipe = {
  id: string;
  name: string;
  sellingPriceCents: number | null;
  yieldPortions: number;
  yieldPercentage: number;
  laborCostCents: number;
  energyCostCents: number;
  packagingCostCents: number;
  lines: CatalogueRecipeLine[];
};

export type CatalogueMenu = {
  id: string;
  name: string;
  sellingPriceCents: number | null;
  lines: { recipeId: string; quantity: number }[];
};

export type ActiveCatalogue = {
  ingredients: CatalogueIngredient[];
  recipes: CatalogueRecipe[];
  menus: CatalogueMenu[];
};

export async function loadActiveCatalogue(
  db: TenantClient,
  organizationId: string,
): Promise<ActiveCatalogue> {
  const [recipesWithLines, ingredientRows, menuRows] = await Promise.all([
    listRecipesWithLines(db, organizationId),
    listIngredients(db, organizationId),
    listMenus(db, organizationId),
  ]);

  // Reach `menu_items` directly (one extra org-scoped query) rather than the
  // manager menu loader, because consumers recompute menu cost themselves.
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

  const ingredients: CatalogueIngredient[] = ingredientRows.map((i) => ({
    id: i.id,
    name: i.name,
    priceCents: i.priceCents,
    pendingPriceCents: i.pendingPriceCents,
    needsPricing: i.needsPricing,
  }));

  const recipes: CatalogueRecipe[] = recipesWithLines.map(({ recipe, lines }) => ({
    id: recipe.id,
    name: recipe.name,
    sellingPriceCents: recipe.sellingPriceCents,
    yieldPortions: recipe.yieldPortions,
    yieldPercentage: recipe.yieldPercentage,
    laborCostCents: recipe.laborCostCents,
    energyCostCents: recipe.energyCostCents,
    packagingCostCents: recipe.packagingCostCents,
    lines: lines.map((l) => ({
      ingredientId: l.ingredientId,
      dimension: l.ingredient.dimension,
      priceCents: l.ingredient.priceCents,
      quantity: l.quantity,
    })),
  }));

  const linesByMenu = new Map<string, { recipeId: string; quantity: number }[]>();
  for (const row of menuItemRows) {
    const line = { recipeId: row.recipeId, quantity: row.quantity };
    const existing = linesByMenu.get(row.menuId);
    if (existing) existing.push(line);
    else linesByMenu.set(row.menuId, [line]);
  }

  const menus: CatalogueMenu[] = menuRows.map((m) => ({
    id: m.id,
    name: m.name,
    sellingPriceCents: m.sellingPriceCents,
    lines: linesByMenu.get(m.id) ?? [],
  }));

  return { ingredients, recipes, menus };
}
