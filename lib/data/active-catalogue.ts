import { and, asc, eq, inArray } from 'drizzle-orm';
import { menuItems, recipeComponents } from '@/lib/db/schema';
import type { Dimension } from '@/lib/units';
import type { TenantClient } from '@/lib/db/tenant';
import { listRecipesWithLines } from '@/lib/data/recipes';
import { listIngredients } from '@/lib/data/ingredients';
import { listMenus } from '@/lib/data/menus';
import { loadDefaultPortionPrices } from '@/lib/data/recipe-portion-options';
import { MAX_COMPONENT_DEPTH } from '@/lib/calculations/production';

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
  /**
   * Prep-action usable yield in basis points, or null/absent when the line has
   * no prep action (Recipes 2.0 §6.6). Feeds `lineCostCents` so required-
   * purchase loss inflates cost identically to the recipe cost card. Carried
   * through sub-recipe flattening via spread.
   */
  prepYieldBps?: number | null;
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
  /**
   * Direct ingredient lines PLUS the recipe's sub-recipe component subtrees
   * FLATTENED into equivalent raw-ingredient lines (quantities scaled by the
   * component grams / child yield weight / child loss chain — the locked
   * sub-recipes math). Because the flattened lines keep their real
   * `ingredientId` + per-unit `priceCents`, every catalogue consumer — cost,
   * price simulation, unpriced detection, prep/reorder demand — cascades
   * through components with no consumer-side recursion.
   */
  lines: CatalogueRecipeLine[];
  /**
   * Price-INDEPENDENT slice of the component subtrees (child labor/energy/
   * packaging, scaled). Feed as `componentMaterialCostsCents: [this]` so it
   * joins the material bucket before the parent's loss adjustment.
   */
  componentHiddenCostCents: number;
  /**
   * True when a component subtree could not be resolved (missing/trashed/
   * no-yield child, cycle, over-depth — corrupted data). Consumers must treat
   * this recipe's cost as unknown (null), never as the partial sum.
   */
  costUnresolved: boolean;
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

  // ── Sub-recipe flattening ────────────────────────────────────────────────────
  // One org-scoped query for all component edges among active recipes, then a
  // memoized DFS that turns each recipe's component subtree into (a) raw
  // ingredient lines scaled by Π (grams / childYieldWeight / childYieldFraction)
  // and (b) a scaled price-independent hidden-cost constant. Guards mirror the
  // shared resolver: missing/trashed/no-yield child, cycle, or over-depth makes
  // the recipe `costUnresolved` instead of silently under-counting.
  const componentEdges =
    recipesWithLines.length === 0
      ? []
      : await db
          .select({
            recipeId: recipeComponents.recipeId,
            componentRecipeId: recipeComponents.componentRecipeId,
            quantityGrams: recipeComponents.quantityGrams,
          })
          .from(recipeComponents)
          .where(
            and(
              eq(recipeComponents.organizationId, organizationId),
              inArray(
                recipeComponents.recipeId,
                recipesWithLines.map(({ recipe }) => recipe.id),
              ),
            ),
          );
  const edgesByParent = new Map<string, typeof componentEdges>();
  for (const edge of componentEdges) {
    const existing = edgesByParent.get(edge.recipeId);
    if (existing) existing.push(edge);
    else edgesByParent.set(edge.recipeId, [edge]);
  }
  const activeById = new Map(recipesWithLines.map((r) => [r.recipe.id, r]));

  type Flattened = { lines: CatalogueRecipeLine[]; hiddenCents: number } | null;
  // Per-BATCH flattened subtree of a recipe (its own direct lines + descendants).
  const flatMemo = new Map<string, Flattened>();
  const flattenBatch = (
    recipeId: string,
    depth: number,
    visited: Set<string>,
  ): Flattened => {
    const cached = flatMemo.get(recipeId);
    if (cached !== undefined) return cached;
    const entry = activeById.get(recipeId);
    if (!entry) {
      flatMemo.set(recipeId, null);
      return null;
    }
    const out: CatalogueRecipeLine[] = entry.lines.map((l) => ({
      ingredientId: l.ingredientId,
      dimension: l.ingredient.dimension,
      priceCents: l.ingredient.priceCents,
      quantity: l.quantity,
      prepYieldBps: l.prepYieldBps ?? null,
    }));
    let hiddenCents = 0;
    for (const edge of edgesByParent.get(recipeId) ?? []) {
      if (depth >= MAX_COMPONENT_DEPTH || visited.has(edge.componentRecipeId)) {
        flatMemo.set(recipeId, null);
        return null;
      }
      const child = activeById.get(edge.componentRecipeId);
      const childYield = child?.recipe.yieldWeightGrams;
      const childLossPct = child?.recipe.yieldPercentage;
      if (
        !child ||
        childYield == null ||
        !Number.isFinite(childYield) ||
        childYield <= 0 ||
        !Number.isFinite(childLossPct) ||
        (childLossPct ?? 0) <= 0
      ) {
        flatMemo.set(recipeId, null);
        return null;
      }
      const nextVisited = new Set(visited);
      nextVisited.add(edge.componentRecipeId);
      const sub = flattenBatch(edge.componentRecipeId, depth + 1, nextVisited);
      if (sub === null) {
        flatMemo.set(recipeId, null);
        return null;
      }
      // Finished-output slice of the child batch, then the child's own loss
      // (material only — hidden costs are per-batch, never loss-adjusted).
      const batchScale = edge.quantityGrams / childYield;
      const materialScale = batchScale / ((childLossPct as number) / 100);
      for (const line of sub.lines) {
        out.push({ ...line, quantity: line.quantity * materialScale });
      }
      const childHidden =
        child.recipe.laborCostCents +
        child.recipe.energyCostCents +
        child.recipe.packagingCostCents;
      // The child's own hidden costs enter the child TOTAL after the child's
      // loss → scale by the plain batch slice. Grandchild hidden constants sit
      // inside the child's MATERIAL bucket (component raw costs), so they get
      // the child's loss adjustment too → scale like material.
      hiddenCents += batchScale * childHidden + materialScale * sub.hiddenCents;
    }
    const result = { lines: out, hiddenCents };
    flatMemo.set(recipeId, result);
    return result;
  };

  // Dual-read (Fase 5, §6.8): a priced default portion option overrides the
  // legacy column for every catalogue consumer (CFO, daily-close, menu
  // engineering, profit leaks).
  const defaultPortionPrices = await loadDefaultPortionPrices(
    db,
    organizationId,
    recipesWithLines.map(({ recipe }) => recipe.id),
  );

  const recipes: CatalogueRecipe[] = recipesWithLines.map(({ recipe, lines }) => {
    const directLines: CatalogueRecipeLine[] = lines.map((l) => ({
      ingredientId: l.ingredientId,
      dimension: l.ingredient.dimension,
      priceCents: l.ingredient.priceCents,
      quantity: l.quantity,
      prepYieldBps: l.prepYieldBps ?? null,
    }));
    const hasComponents = edgesByParent.has(recipe.id);
    const flattened = hasComponents
      ? flattenBatch(recipe.id, 0, new Set([recipe.id]))
      : null;
    return {
      id: recipe.id,
      name: recipe.name,
      sellingPriceCents:
        defaultPortionPrices.get(recipe.id) ?? recipe.sellingPriceCents,
      yieldPortions: recipe.yieldPortions,
      yieldPercentage: recipe.yieldPercentage,
      laborCostCents: recipe.laborCostCents,
      energyCostCents: recipe.energyCostCents,
      packagingCostCents: recipe.packagingCostCents,
      lines: hasComponents && flattened ? flattened.lines : directLines,
      componentHiddenCostCents: hasComponents && flattened ? flattened.hiddenCents : 0,
      costUnresolved: hasComponents && flattened === null,
    };
  });

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
