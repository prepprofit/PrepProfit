import { and, asc, count, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  ingredients,
  menuFolders,
  menuIngredientItems,
  menuItems,
  menus,
  recipes,
} from '@/lib/db/schema';
import type { Menu, MenuFolder } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import type { Dimension } from '@/lib/units';
import { costPerKgCents, recipeCost } from '@/lib/calculations/recipeCost';
import {
  compositionCost,
  dishPricing,
  ingredientCanonicalQuantity,
  ingredientDisplayAmount,
  isIngredientUnitFor,
  type DishIngredientUnit,
  type DishRecipeUnit,
} from '@/lib/calculations/dish';
import { mergeMenuAllergens, type MenuAllergen } from '@/lib/calculations/menu';
import type { RecipeAllergenRollup } from '@/lib/calculations/allergens';
import { loadActiveCatalogue, type ActiveCatalogue } from '@/lib/data/active-catalogue';
import {
  loadIngredientAllergensByIngredient,
  loadRecipeAllergensByIds,
} from '@/lib/data/allergens';
import { MAX_DISH_AMOUNT, type DishFormInput, type DishSort } from '@/lib/validation/menus';

/**
 * Menu data layer (Menu redesign — folders + Dish Builder). A "dish" is a `menus`
 * row: recipe lines (`menu_items`, by portion/g/kg) + direct ingredient lines
 * (`menu_ingredient_items`), making `portions`, priced per portion excl. VAT.
 *
 * RULE #1: every function is org-scoped and runs inside the caller's `withOrg`.
 * Cost is NEVER stored: it derives on read from current recipe + ingredient prices
 * through `compositionCost`, the same function every insight module uses.
 *
 * F4 BY CONSTRUCTION: kitchen loaders (`listKitchenDishes` / `getKitchenDish`) never
 * select prices or call a cost function, and their DTO types hold no money keys.
 */

// ── Identity reads ───────────────────────────────────────────────────────────

/** Active dishes, by name. */
export async function listMenus(db: TenantClient, organizationId: string): Promise<Menu[]> {
  return db
    .select()
    .from(menus)
    .where(and(eq(menus.organizationId, organizationId), isNull(menus.deletedAt)))
    .orderBy(menus.name);
}

export async function getMenuById(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Menu | null> {
  const rows = await db
    .select()
    .from(menus)
    .where(and(eq(menus.organizationId, organizationId), eq(menus.id, id), isNull(menus.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listTrashedMenus(db: TenantClient, organizationId: string): Promise<Menu[]> {
  return db
    .select()
    .from(menus)
    .where(and(eq(menus.organizationId, organizationId), isNotNull(menus.deletedAt)))
    .orderBy(desc(menus.deletedAt));
}

// ── Folders ──────────────────────────────────────────────────────────────────

export type MenuFolderSummary = { id: string; name: string; dishCount: number };

/** Every folder with its active-dish count, plus how many active dishes are unfiled. */
export async function listMenuFolders(
  db: TenantClient,
  organizationId: string,
): Promise<{ folders: MenuFolderSummary[]; unfiledCount: number }> {
  const [folderRows, countRows] = await Promise.all([
    db
      .select({ id: menuFolders.id, name: menuFolders.name })
      .from(menuFolders)
      .where(eq(menuFolders.organizationId, organizationId))
      .orderBy(asc(menuFolders.name)),
    db
      .select({ folderId: menus.folderId, value: count() })
      .from(menus)
      .where(and(eq(menus.organizationId, organizationId), isNull(menus.deletedAt)))
      .groupBy(menus.folderId),
  ]);
  const counts = new Map(countRows.map((r) => [r.folderId, r.value]));
  return {
    folders: folderRows.map((f) => ({ id: f.id, name: f.name, dishCount: counts.get(f.id) ?? 0 })),
    unfiledCount: counts.get(null) ?? 0,
  };
}

export async function getMenuFolder(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<MenuFolder | null> {
  const rows = await db
    .select()
    .from(menuFolders)
    .where(and(eq(menuFolders.organizationId, organizationId), eq(menuFolders.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listMenuFolderOptions(
  db: TenantClient,
  organizationId: string,
): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: menuFolders.id, name: menuFolders.name })
    .from(menuFolders)
    .where(eq(menuFolders.organizationId, organizationId))
    .orderBy(asc(menuFolders.name));
}

/** Throws a unique violation on a duplicate name (the action maps it). */
export async function createMenuFolder(
  db: TenantClient,
  organizationId: string,
  name: string,
): Promise<MenuFolder> {
  const [row] = await db.insert(menuFolders).values({ organizationId, name }).returning();
  if (!row) throw new Error('Failed to create menu folder.');
  return row;
}

export async function renameMenuFolder(
  db: TenantClient,
  organizationId: string,
  id: string,
  name: string,
): Promise<MenuFolder | null> {
  const [row] = await db
    .update(menuFolders)
    .set({ name })
    .where(and(eq(menuFolders.organizationId, organizationId), eq(menuFolders.id, id)))
    .returning();
  return row ?? null;
}

/**
 * Delete a folder; its dishes (active AND trashed) move to Unfiled first, so the
 * restrict FK never blocks and a later restore lands somewhere visible.
 */
export async function deleteMenuFolder(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<{ deleted: boolean; movedDishes: number }> {
  const moved = await db
    .update(menus)
    .set({ folderId: null })
    .where(and(eq(menus.organizationId, organizationId), eq(menus.folderId, id)))
    .returning({ id: menus.id });
  const deleted = await db
    .delete(menuFolders)
    .where(and(eq(menuFolders.organizationId, organizationId), eq(menuFolders.id, id)))
    .returning({ id: menuFolders.id });
  return { deleted: deleted.length > 0, movedDishes: moved.length };
}

// ── Search (money-free; both roles) ──────────────────────────────────────────

export type DishSearchResult = { id: string; name: string; folderName: string | null };

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Every active dish in the org by name — typo tolerant, regardless of folder. */
export async function searchDishes(
  db: TenantClient,
  organizationId: string,
  query: string,
  limit = 20,
): Promise<DishSearchResult[]> {
  const like = `%${escapeLike(query)}%`;
  const rows = await db
    .select({ id: menus.id, name: menus.name, folderName: menuFolders.name })
    .from(menus)
    .leftJoin(
      menuFolders,
      and(eq(menuFolders.organizationId, organizationId), eq(menuFolders.id, menus.folderId)),
    )
    .where(
      and(
        eq(menus.organizationId, organizationId),
        isNull(menus.deletedAt),
        sql`(${menus.name} % ${query} OR ${menus.name} ILIKE ${like})`,
      ),
    )
    .orderBy(
      sql`(${menus.name} ILIKE ${`${escapeLike(query)}%`}) DESC`,
      sql`similarity(${menus.name}, ${query}) DESC`,
      asc(menus.name),
    )
    .limit(limit);
  return rows.map((r) => ({ id: r.id, name: r.name, folderName: r.folderName ?? null }));
}

// ── Catalogue-derived costs (manager only) ───────────────────────────────────

type RecipeCostView = {
  costPerPortionCents: number | null;
  costPerKgCents: number | null;
};

/**
 * Honest per-recipe costs from the catalogue: a recipe with an unpriced ingredient or
 * an unresolvable sub-recipe tree costs as UNKNOWN (null), never understated.
 */
function recipeCostsFromCatalogue(catalogue: ActiveCatalogue): Map<string, RecipeCostView> {
  const needsPricing = new Set(catalogue.ingredients.filter((i) => i.needsPricing).map((i) => i.id));
  const out = new Map<string, RecipeCostView>();
  for (const recipe of catalogue.recipes) {
    const unpriced =
      recipe.costUnresolved || recipe.lines.some((l) => needsPricing.has(l.ingredientId));
    if (unpriced) {
      out.set(recipe.id, { costPerPortionCents: null, costPerKgCents: null });
      continue;
    }
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
        prepYieldBps: l.prepYieldBps ?? undefined,
      })),
      componentMaterialCostsCents: [recipe.componentHiddenCostCents],
    });
    out.set(recipe.id, {
      costPerPortionCents: cost.costPerPortionCents,
      costPerKgCents: costPerKgCents(cost.totalCostCents, recipe.yieldWeightGrams),
    });
  }
  return out;
}

// ── Folder view: dish list ───────────────────────────────────────────────────

export type DishListItem = {
  id: string;
  name: string;
  portions: number;
  componentCount: number;
  createdAt: Date;
  updatedAt: Date;
  lastOpenedAt: Date | null;
};

export type ManagerDishListItem = DishListItem & {
  sellingPriceCents: number | null;
  costPerPortionCents: number | null;
  marginBps: number | null;
};

export const DISH_LIST_LIMIT = 500;

function dishOrder(sort: DishSort) {
  switch (sort) {
    case 'name':
      return [asc(menus.name)];
    case 'created':
      return [desc(menus.createdAt), asc(menus.name)];
    case 'opened':
      return [sql`${menus.lastOpenedAt} DESC NULLS LAST`, asc(menus.name)];
    case 'modified':
    default:
      return [desc(menus.updatedAt), asc(menus.name)];
  }
}

async function listDishRows(
  db: TenantClient,
  organizationId: string,
  folderId: string | null,
  sort: DishSort,
) {
  const rows = await db
    .select()
    .from(menus)
    .where(
      and(
        eq(menus.organizationId, organizationId),
        isNull(menus.deletedAt),
        folderId === null ? isNull(menus.folderId) : eq(menus.folderId, folderId),
      ),
    )
    .orderBy(...dishOrder(sort))
    .limit(DISH_LIST_LIMIT);

  const ids = rows.map((r) => r.id);
  const [recipeCounts, ingredientCounts] =
    ids.length === 0
      ? [[], []]
      : await Promise.all([
          db
            .select({ menuId: menuItems.menuId, value: count() })
            .from(menuItems)
            .where(and(eq(menuItems.organizationId, organizationId), inArray(menuItems.menuId, ids)))
            .groupBy(menuItems.menuId),
          db
            .select({ menuId: menuIngredientItems.menuId, value: count() })
            .from(menuIngredientItems)
            .where(
              and(
                eq(menuIngredientItems.organizationId, organizationId),
                inArray(menuIngredientItems.menuId, ids),
              ),
            )
            .groupBy(menuIngredientItems.menuId),
        ]);
  const componentCount = new Map<string, number>();
  for (const r of [...recipeCounts, ...ingredientCounts]) {
    componentCount.set(r.menuId, (componentCount.get(r.menuId) ?? 0) + r.value);
  }
  return { rows, componentCount };
}

export async function listKitchenDishes(
  db: TenantClient,
  organizationId: string,
  folderId: string | null,
  sort: DishSort,
): Promise<DishListItem[]> {
  const { rows, componentCount } = await listDishRows(db, organizationId, folderId, sort);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    portions: r.portions,
    componentCount: componentCount.get(r.id) ?? 0,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastOpenedAt: r.lastOpenedAt,
  }));
}

export async function listManagerDishes(
  db: TenantClient,
  organizationId: string,
  folderId: string | null,
  sort: DishSort,
): Promise<ManagerDishListItem[]> {
  const [{ rows, componentCount }, catalogue] = await Promise.all([
    listDishRows(db, organizationId, folderId, sort),
    loadActiveCatalogue(db, organizationId),
  ]);
  const recipeCosts = recipeCostsFromCatalogue(catalogue);
  const recipeById = new Map(catalogue.recipes.map((r) => [r.id, r]));
  const ingredientById = new Map(catalogue.ingredients.map((i) => [i.id, i]));
  const menuById = new Map(catalogue.menus.map((m) => [m.id, m]));

  return rows.map((r) => {
    const composition = menuById.get(r.id);
    const cost = composition
      ? compositionCost(composition, {
          recipeCostPerPortion: (id) => recipeCosts.get(id)?.costPerPortionCents ?? null,
          recipeYield: (id) => recipeById.get(id) ?? null,
          ingredient: (id) => ingredientById.get(id) ?? null,
        })
      : null;
    const costPerPortion = cost?.costPerPortionCents ?? null;
    return {
      id: r.id,
      name: r.name,
      portions: r.portions,
      componentCount: componentCount.get(r.id) ?? 0,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      lastOpenedAt: r.lastOpenedAt,
      sellingPriceCents: r.sellingPriceCents,
      costPerPortionCents: costPerPortion,
      marginBps: dishPricing(costPerPortion, r.sellingPriceCents, 0).marginBps,
    };
  });
}

// ── Dish detail ──────────────────────────────────────────────────────────────

type DishIdentity = {
  id: string;
  name: string;
  folderId: string | null;
  portions: number;
  notes: string | null;
};

export type KitchenDishRecipeLine = {
  recipeId: string;
  recipeName: string;
  quantity: number;
  unit: DishRecipeUnit;
  available: boolean;
};

export type KitchenDishIngredientLine = {
  ingredientId: string;
  ingredientName: string;
  /** Amount in `unit` (converted back from canonical). */
  quantity: number;
  unit: DishIngredientUnit;
  available: boolean;
};

export type KitchenDishDetail = DishIdentity & {
  recipeLines: KitchenDishRecipeLine[];
  ingredientLines: KitchenDishIngredientLine[];
  allergens: MenuAllergen[];
  hasUnreviewedIngredient: boolean;
};

export type ManagerDishDetail = DishIdentity & {
  sellingPriceCents: number | null;
  vatRateBps: number | null;
  recipeLines: KitchenDishRecipeLine[];
  ingredientLines: KitchenDishIngredientLine[];
};

async function loadDishLines(db: TenantClient, organizationId: string, menuId: string) {
  const [recipeRows, ingredientRows] = await Promise.all([
    db
      .select({
        recipeId: menuItems.recipeId,
        quantity: menuItems.quantity,
        unit: menuItems.unit,
        recipeName: recipes.name,
        recipeDeletedAt: recipes.deletedAt,
      })
      .from(menuItems)
      .innerJoin(
        recipes,
        and(eq(recipes.organizationId, organizationId), eq(recipes.id, menuItems.recipeId)),
      )
      .where(and(eq(menuItems.organizationId, organizationId), eq(menuItems.menuId, menuId)))
      .orderBy(asc(menuItems.sortOrder)),
    db
      .select({
        ingredientId: menuIngredientItems.ingredientId,
        quantity: menuIngredientItems.quantity,
        unit: menuIngredientItems.unit,
        ingredientName: ingredients.name,
        ingredientDeletedAt: ingredients.deletedAt,
      })
      .from(menuIngredientItems)
      .innerJoin(
        ingredients,
        and(
          eq(ingredients.organizationId, organizationId),
          eq(ingredients.id, menuIngredientItems.ingredientId),
        ),
      )
      .where(
        and(
          eq(menuIngredientItems.organizationId, organizationId),
          eq(menuIngredientItems.menuId, menuId),
        ),
      )
      .orderBy(asc(menuIngredientItems.sortOrder)),
  ]);
  const recipeLines: KitchenDishRecipeLine[] = recipeRows.map((r) => ({
    recipeId: r.recipeId,
    recipeName: r.recipeName,
    quantity: r.quantity,
    unit: r.unit,
    available: r.recipeDeletedAt === null,
  }));
  const ingredientLines: KitchenDishIngredientLine[] = ingredientRows.map((r) => ({
    ingredientId: r.ingredientId,
    ingredientName: r.ingredientName,
    quantity: ingredientDisplayAmount(r.quantity, r.unit),
    unit: r.unit,
    available: r.ingredientDeletedAt === null,
  }));
  return { recipeLines, ingredientLines };
}

export async function getManagerDish(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<ManagerDishDetail | null> {
  const menu = await getMenuById(db, organizationId, id);
  if (!menu) return null;
  const lines = await loadDishLines(db, organizationId, id);
  return {
    id: menu.id,
    name: menu.name,
    folderId: menu.folderId,
    portions: menu.portions,
    notes: menu.notes,
    sellingPriceCents: menu.sellingPriceCents,
    vatRateBps: menu.vatRateBps,
    ...lines,
  };
}

export async function getKitchenDish(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<KitchenDishDetail | null> {
  const menu = await getMenuById(db, organizationId, id);
  if (!menu) return null;
  const lines = await loadDishLines(db, organizationId, id);
  const [recipeAllergens, ingredientAllergens, reviewRows] = await Promise.all([
    loadRecipeAllergensByIds(db, organizationId, lines.recipeLines.map((l) => l.recipeId)),
    loadIngredientAllergensByIngredient(
      db,
      organizationId,
      lines.ingredientLines.map((l) => l.ingredientId),
    ),
    lines.ingredientLines.length === 0
      ? Promise.resolve([])
      : db
          .select({ id: ingredients.id, reviewedAt: ingredients.allergensReviewedAt })
          .from(ingredients)
          .where(
            and(
              eq(ingredients.organizationId, organizationId),
              inArray(
                ingredients.id,
                lines.ingredientLines.map((l) => l.ingredientId),
              ),
            ),
          ),
  ]);
  const reviewed = new Map(reviewRows.map((r) => [r.id, r.reviewedAt !== null]));
  const rollups: RecipeAllergenRollup[] = [
    ...lines.recipeLines.map((l) => recipeAllergens.get(l.recipeId)).filter((r) => r != null),
    ...lines.ingredientLines.map((l) => ({
      allergens: (ingredientAllergens.get(l.ingredientId) ?? []).map((tag) => ({
        allergen: tag.allergen,
        derivedPresence: tag.presence,
        overridePresence: null,
        effectivePresence: tag.presence,
      })),
      hasUnreviewedIngredient: reviewed.get(l.ingredientId) !== true,
    })),
  ];
  const rollup = mergeMenuAllergens(rollups);
  return {
    id: menu.id,
    name: menu.name,
    folderId: menu.folderId,
    portions: menu.portions,
    notes: menu.notes,
    ...lines,
    allergens: rollup.allergens,
    hasUnreviewedIngredient: rollup.hasUnreviewedIngredient,
  };
}

// ── Builder options (manager only — carry money) ─────────────────────────────

export type DishRecipeOption = {
  id: string;
  name: string;
  yieldPortions: number;
  yieldWeightGrams: number | null;
  /** Null when an ingredient needs pricing or the sub-recipe tree is unresolvable. */
  costPerPortionCents: number | null;
  costPerKgCents: number | null;
};

export type DishIngredientOption = {
  id: string;
  name: string;
  dimension: Dimension;
  /** Price per kg / litre / piece, cents. */
  priceCents: number;
  needsPricing: boolean;
};

export async function listDishBuilderOptions(
  db: TenantClient,
  organizationId: string,
): Promise<{ recipes: DishRecipeOption[]; ingredients: DishIngredientOption[] }> {
  const catalogue = await loadActiveCatalogue(db, organizationId);
  const costs = recipeCostsFromCatalogue(catalogue);
  return {
    recipes: catalogue.recipes
      .map((r) => ({
        id: r.id,
        name: r.name,
        yieldPortions: r.yieldPortions,
        yieldWeightGrams: r.yieldWeightGrams,
        costPerPortionCents: costs.get(r.id)?.costPerPortionCents ?? null,
        costPerKgCents: costs.get(r.id)?.costPerKgCents ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    ingredients: catalogue.ingredients
      .map((i) => ({
        id: i.id,
        name: i.name,
        dimension: i.dimension,
        priceCents: i.priceCents,
        needsPricing: i.needsPricing,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ── Mutations ────────────────────────────────────────────────────────────────

export type SaveDishOutcome =
  | { status: 'ok'; menu: Menu }
  | { status: 'not_found' }
  | { status: 'invalid_recipe' }
  | { status: 'invalid_ingredient' }
  | { status: 'invalid_folder' };

/**
 * Lock + validate every referenced row in one pass (id-ascending FOR UPDATE, so it
 * serializes with a concurrent trash): recipes and ingredients must be ACTIVE and
 * same-org; an ingredient's unit must match its dimension; the folder must exist.
 */
async function validateDishReferences(
  db: TenantClient,
  organizationId: string,
  input: DishFormInput,
): Promise<'ok' | 'invalid_recipe' | 'invalid_ingredient' | 'invalid_folder'> {
  if (input.folderId !== null && !(await getMenuFolder(db, organizationId, input.folderId))) {
    return 'invalid_folder';
  }
  const recipeIds = input.recipeLines.map((l) => l.recipeId);
  if (recipeIds.length > 0) {
    const locked = await db
      .select({ id: recipes.id })
      .from(recipes)
      .where(
        and(
          eq(recipes.organizationId, organizationId),
          inArray(recipes.id, recipeIds),
          isNull(recipes.deletedAt),
        ),
      )
      .orderBy(asc(recipes.id))
      .for('update');
    if (locked.length !== recipeIds.length) return 'invalid_recipe';
  }
  const ingredientIds = input.ingredientLines.map((l) => l.ingredientId);
  if (ingredientIds.length > 0) {
    const locked = await db
      .select({ id: ingredients.id, dimension: ingredients.dimension })
      .from(ingredients)
      .where(
        and(
          eq(ingredients.organizationId, organizationId),
          inArray(ingredients.id, ingredientIds),
          isNull(ingredients.deletedAt),
        ),
      )
      .orderBy(asc(ingredients.id))
      .for('update');
    if (locked.length !== ingredientIds.length) return 'invalid_ingredient';
    const dimensionById = new Map(locked.map((r) => [r.id, r.dimension]));
    for (const line of input.ingredientLines) {
      const dimension = dimensionById.get(line.ingredientId);
      if (!dimension || !isIngredientUnitFor(line.unit, dimension)) return 'invalid_ingredient';
      const canonical = ingredientCanonicalQuantity(line.quantity, line.unit);
      if (!Number.isFinite(canonical) || canonical <= 0 || canonical > MAX_DISH_AMOUNT) {
        return 'invalid_ingredient';
      }
    }
  }
  return 'ok';
}

async function insertDishLines(
  db: TenantClient,
  organizationId: string,
  menuId: string,
  input: DishFormInput,
): Promise<void> {
  if (input.recipeLines.length > 0) {
    await db.insert(menuItems).values(
      input.recipeLines.map((line, index) => ({
        organizationId,
        menuId,
        recipeId: line.recipeId,
        quantity: line.quantity,
        unit: line.unit,
        sortOrder: index,
      })),
    );
  }
  if (input.ingredientLines.length > 0) {
    await db.insert(menuIngredientItems).values(
      input.ingredientLines.map((line, index) => ({
        organizationId,
        menuId,
        ingredientId: line.ingredientId,
        quantity: ingredientCanonicalQuantity(line.quantity, line.unit),
        unit: line.unit,
        sortOrder: index,
      })),
    );
  }
}

function dishFields(input: DishFormInput) {
  return {
    name: input.name,
    folderId: input.folderId,
    portions: input.portions,
    sellingPriceCents: input.sellingPriceCents,
    vatRateBps: input.vatRateBps,
    notes: input.notes ?? null,
  };
}

export async function createDish(
  db: TenantClient,
  organizationId: string,
  input: DishFormInput,
): Promise<SaveDishOutcome> {
  const check = await validateDishReferences(db, organizationId, input);
  if (check !== 'ok') return { status: check };
  const [menu] = await db
    .insert(menus)
    .values({ organizationId, ...dishFields(input), lastOpenedAt: new Date() })
    .returning();
  if (!menu) throw new Error('Failed to create dish.');
  await insertDishLines(db, organizationId, menu.id, input);
  return { status: 'ok', menu };
}

/** Replace an active dish's fields + full composition in one transaction. */
export async function updateDish(
  db: TenantClient,
  organizationId: string,
  id: string,
  input: DishFormInput,
): Promise<SaveDishOutcome> {
  const scope = and(eq(menus.organizationId, organizationId), eq(menus.id, id), isNull(menus.deletedAt));
  const lock = await db.select({ id: menus.id }).from(menus).where(scope).for('update');
  if (lock.length === 0) return { status: 'not_found' };

  const check = await validateDishReferences(db, organizationId, input);
  if (check !== 'ok') return { status: check };

  const [menu] = await db.update(menus).set(dishFields(input)).where(scope).returning();
  if (!menu) return { status: 'not_found' };

  await db
    .delete(menuItems)
    .where(and(eq(menuItems.organizationId, organizationId), eq(menuItems.menuId, id)));
  await db
    .delete(menuIngredientItems)
    .where(
      and(eq(menuIngredientItems.organizationId, organizationId), eq(menuIngredientItems.menuId, id)),
    );
  await insertDishLines(db, organizationId, id, input);
  return { status: 'ok', menu };
}

/** Stamp "last opened" WITHOUT touching `updated_at` (opening is not a modification). */
export async function markDishOpened(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<void> {
  await db
    .update(menus)
    .set({ lastOpenedAt: new Date(), updatedAt: sql`${menus.updatedAt}` })
    .where(and(eq(menus.organizationId, organizationId), eq(menus.id, id), isNull(menus.deletedAt)));
}

/** Move an active dish to the trash. Returns null if it was not active. */
export async function softDeleteMenu(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Menu | null> {
  const [row] = await db
    .update(menus)
    .set({ deletedAt: new Date() })
    .where(and(eq(menus.organizationId, organizationId), eq(menus.id, id), isNull(menus.deletedAt)))
    .returning();
  return row ?? null;
}

/** Bring a trashed dish back. Returns null if it was not in the trash. */
export async function restoreMenu(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Menu | null> {
  const [row] = await db
    .update(menus)
    .set({ deletedAt: null })
    .where(and(eq(menus.organizationId, organizationId), eq(menus.id, id), isNotNull(menus.deletedAt)))
    .returning();
  return row ?? null;
}

/** Permanently delete a trashed dish; both line tables cascade via composite FKs. */
export async function purgeMenu(db: TenantClient, organizationId: string, id: string): Promise<void> {
  await db
    .delete(menus)
    .where(and(eq(menus.organizationId, organizationId), eq(menus.id, id), isNotNull(menus.deletedAt)));
}

/** menu_items rows referencing a recipe (any dish state) — the recipe-purge guard. */
export async function countMenusUsingRecipe(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(menuItems)
    .where(and(eq(menuItems.organizationId, organizationId), eq(menuItems.recipeId, recipeId)));
  return rows[0]?.value ?? 0;
}
