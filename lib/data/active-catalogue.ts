import { and, asc, eq, inArray } from 'drizzle-orm';
import { menuExtras, menuIngredientItems, menuItems, recipeComponents } from '@/lib/db/schema';
import {
  compositionCost,
  type DishComposition,
  type DishCost,
  type DishCostLookups,
  type PriceBasis,
} from '@/lib/calculations/dish';
import { recipeCost } from '@/lib/calculations/recipeCost';
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
  dimension: Dimension;
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
  /** Finished batch weight (g); needed to convert dish gram lines to portions. */
  yieldWeightGrams: number | null;
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
   * The LABOUR part of `componentHiddenCostCents` (sub-recipe labour, scaled the same
   * way). A Menu dish with its own production labour subtracts it — together with
   * the recipe's own `laborCostCents` — so recipe labour is never counted twice.
   */
  componentLaborCostCents: number;
  /**
   * True when a component subtree could not be resolved (missing/trashed/
   * no-yield child, cycle, over-depth — corrupted data). Consumers must treat
   * this recipe's cost as unknown (null), never as the partial sum.
   */
  costUnresolved: boolean;
};

/**
 * A Menu product (one batch). `sellingPriceCents` is excl. VAT per `priceBasis` (per
 * kg or per output unit). Cost it with `catalogueDishCosts` / `compositionCost` —
 * never by summing `recipeLines` alone.
 */
export type CatalogueMenu = DishComposition & {
  id: string;
  name: string;
  sellingPriceCents: number | null;
  priceBasis: PriceBasis;
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
  const menuIds = menuRows.map((m) => m.id);
  const [menuItemRows, menuIngredientRows, menuExtraRows] =
    menuIds.length === 0
      ? [[], [], []]
      : await Promise.all([
          db
            .select({
              menuId: menuItems.menuId,
              recipeId: menuItems.recipeId,
              quantity: menuItems.quantity,
              unit: menuItems.unit,
            })
            .from(menuItems)
            .where(
              and(eq(menuItems.organizationId, organizationId), inArray(menuItems.menuId, menuIds)),
            )
            .orderBy(asc(menuItems.menuId), asc(menuItems.sortOrder)),
          db
            .select({
              menuId: menuIngredientItems.menuId,
              ingredientId: menuIngredientItems.ingredientId,
              quantity: menuIngredientItems.quantity,
              unit: menuIngredientItems.unit,
            })
            .from(menuIngredientItems)
            .where(
              and(
                eq(menuIngredientItems.organizationId, organizationId),
                inArray(menuIngredientItems.menuId, menuIds),
              ),
            )
            .orderBy(asc(menuIngredientItems.menuId), asc(menuIngredientItems.sortOrder)),
          db
            .select()
            .from(menuExtras)
            .where(and(eq(menuExtras.organizationId, organizationId), inArray(menuExtras.menuId, menuIds)))
            .orderBy(asc(menuExtras.menuId), asc(menuExtras.sortOrder)),
        ]);

  const ingredients: CatalogueIngredient[] = ingredientRows.map((i) => ({
    id: i.id,
    name: i.name,
    dimension: i.dimension,
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

  type Flattened = { lines: CatalogueRecipeLine[]; hiddenCents: number; laborCents: number } | null;
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
    let laborCents = 0;
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
      // Finished-output slice of the child batch. The child's loss already sits in
      // its finished weight, so material and hidden costs scale alike (loss once).
      const batchScale = edge.quantityGrams / childYield;
      const materialScale = batchScale;
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
      laborCents += batchScale * child.recipe.laborCostCents + materialScale * sub.laborCents;
    }
    const result = { lines: out, hiddenCents, laborCents };
    flatMemo.set(recipeId, result);
    return result;
  };

  // The DEFAULT portion option is the authoritative price for every catalogue
  // consumer (CFO, daily-close, menu engineering, profit leaks). The legacy
  // fallback was retired in Fase 7 Slice 6b — an unpriced default option is
  // honestly unpriced (null), never a fall back to `recipes.selling_price_cents`.
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
      sellingPriceCents: defaultPortionPrices.get(recipe.id) ?? null,
      yieldPortions: recipe.yieldPortions,
      yieldPercentage: recipe.yieldPercentage,
      yieldWeightGrams: recipe.yieldWeightGrams,
      laborCostCents: recipe.laborCostCents,
      energyCostCents: recipe.energyCostCents,
      packagingCostCents: recipe.packagingCostCents,
      lines: hasComponents && flattened ? flattened.lines : directLines,
      componentHiddenCostCents: hasComponents && flattened ? flattened.hiddenCents : 0,
      componentLaborCostCents: hasComponents && flattened ? flattened.laborCents : 0,
      costUnresolved: hasComponents && flattened === null,
    };
  });

  const recipeLinesByMenu = new Map<string, CatalogueMenu['recipeLines']>();
  for (const row of menuItemRows) {
    const line = { recipeId: row.recipeId, quantity: row.quantity, unit: row.unit };
    const existing = recipeLinesByMenu.get(row.menuId);
    if (existing) existing.push(line);
    else recipeLinesByMenu.set(row.menuId, [line]);
  }
  const ingredientLinesByMenu = new Map<string, CatalogueMenu['ingredientLines']>();
  for (const row of menuIngredientRows) {
    const line = { ingredientId: row.ingredientId, quantity: row.quantity, unit: row.unit };
    const existing = ingredientLinesByMenu.get(row.menuId);
    if (existing) existing.push(line);
    else ingredientLinesByMenu.set(row.menuId, [line]);
  }

  const extrasByMenu = new Map<string, DishComposition['extras']>();
  for (const row of menuExtraRows) {
    const extra = extraFromRow(row);
    if (!extra) continue;
    const existing = extrasByMenu.get(row.menuId);
    if (existing) existing.push(extra);
    else extrasByMenu.set(row.menuId, [extra]);
  }

  const menus: CatalogueMenu[] = menuRows.map((m) => ({
    id: m.id,
    name: m.name,
    sellingPriceCents: m.sellingPriceCents,
    priceBasis: m.priceBasis,
    output: {
      quantity: m.outputQuantity,
      unit: m.outputUnit,
      finishedWeightGrams: m.finishedWeightGrams,
    },
    labour:
      m.labourHours !== null && m.labourHourlyCents !== null
        ? { hours: m.labourHours, hourlyCents: m.labourHourlyCents }
        : null,
    extras: extrasByMenu.get(m.id) ?? [],
    recipeLines: recipeLinesByMenu.get(m.id) ?? [],
    ingredientLines: ingredientLinesByMenu.get(m.id) ?? [],
  }));

  return { ingredients, recipes, menus };
}

/** A stored extra row → the pure shape (a malformed row is dropped defensively). */
export function extraFromRow(row: {
  kind: 'work' | 'expense';
  hours: number | null;
  hourlyCents: number | null;
  amountCents: number | null;
}): DishComposition['extras'][number] | null {
  if (row.kind === 'work') {
    return row.hours !== null && row.hourlyCents !== null
      ? { kind: 'work', hours: row.hours, hourlyCents: row.hourlyCents }
      : null;
  }
  return row.amountCents !== null ? { kind: 'expense', amountCents: row.amountCents } : null;
}

/**
 * Honest per-portion recipe costs from the catalogue, with and without recipe labour
 * (own + nested sub-recipe labour). A recipe with an unpriced ingredient or an
 * unresolvable component tree costs as UNKNOWN (null) — never understated.
 */
export function catalogueRecipeCosts(
  catalogue: Pick<ActiveCatalogue, 'ingredients' | 'recipes'>,
): Map<string, { withLabour: number | null; withoutLabour: number | null; totalWithLabour: number | null; totalWithoutLabour: number | null }> {
  const needsPricing = new Set(catalogue.ingredients.filter((i) => i.needsPricing).map((i) => i.id));
  const out = new Map<string, { withLabour: number | null; withoutLabour: number | null; totalWithLabour: number | null; totalWithoutLabour: number | null }>();
  for (const recipe of catalogue.recipes) {
    const unknown =
      recipe.costUnresolved || recipe.lines.some((l) => needsPricing.has(l.ingredientId));
    if (unknown) {
      out.set(recipe.id, { withLabour: null, withoutLabour: null, totalWithLabour: null, totalWithoutLabour: null });
      continue;
    }
    const base = {
      yieldPortions: recipe.yieldPortions,
      yieldPercentage: recipe.yieldPercentage,
      energyCostCents: recipe.energyCostCents,
      packagingCostCents: recipe.packagingCostCents,
      lines: recipe.lines.map((l) => ({
        dimension: l.dimension,
        priceCents: l.priceCents,
        quantity: l.quantity,
        prepYieldBps: l.prepYieldBps ?? undefined,
      })),
    };
    const withLabour = recipeCost({
      ...base,
      laborCostCents: recipe.laborCostCents,
      componentMaterialCostsCents: [recipe.componentHiddenCostCents],
    });
    const withoutLabour = recipeCost({
      ...base,
      laborCostCents: 0,
      componentMaterialCostsCents: [recipe.componentHiddenCostCents - recipe.componentLaborCostCents],
    });
    out.set(recipe.id, {
      withLabour: withLabour.costPerPortionCents,
      withoutLabour: withoutLabour.costPerPortionCents,
      totalWithLabour: withLabour.totalCostCents,
      totalWithoutLabour: withoutLabour.totalCostCents,
    });
  }
  return out;
}

/** Cost lookups over the catalogue's current prices (shared by every Menu consumer). */
export function catalogueDishLookups(
  catalogue: Pick<ActiveCatalogue, 'ingredients' | 'recipes'>,
): DishCostLookups {
  const recipeCosts = catalogueRecipeCosts(catalogue);
  const recipeById = new Map(catalogue.recipes.map((r) => [r.id, r]));
  const ingredientById = new Map(catalogue.ingredients.map((i) => [i.id, i]));
  return {
    recipeCostPerPortion: (id, { excludeLabour }) => {
      const cost = recipeCosts.get(id);
      return (excludeLabour ? cost?.withoutLabour : cost?.withLabour) ?? null;
    },
    recipeYield: (id) => recipeById.get(id) ?? null,
    ingredient: (id) => ingredientById.get(id) ?? null,
  };
}

/** Full cost result for every product in the catalogue. */
export function catalogueDishCosts(
  catalogue: Pick<ActiveCatalogue, 'ingredients' | 'recipes' | 'menus'>,
): Map<string, DishCost> {
  const lookups = catalogueDishLookups(catalogue);
  return new Map(catalogue.menus.map((menu) => [menu.id, compositionCost(menu, lookups)]));
}

/**
 * Cost per SALE UNIT of every product (per kg for weight batches, per piece/cake/
 * portion for count batches) — the unit a sale line's quantity is counted in.
 * Complete-or-null.
 */
export function catalogueDishCostPerSaleUnit(
  catalogue: Pick<ActiveCatalogue, 'ingredients' | 'recipes' | 'menus'>,
): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const [id, cost] of catalogueDishCosts(catalogue)) out.set(id, cost.costPerSaleUnitCents);
  return out;
}
