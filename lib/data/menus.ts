import { and, asc, count, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  ingredients,
  menuItems,
  menus,
  recipeIngredients,
  recipes,
} from '@/lib/db/schema';
import type { Menu } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { recipeCost, type RecipeCostLine } from '@/lib/calculations/recipeCost';
import {
  marginPercent,
  trafficLight,
  type MarginLight,
} from '@/lib/calculations/margin';
import {
  foodCostPercent,
  menuCost,
  mergeMenuAllergens,
  type MenuAllergen,
  type MenuCostLine,
} from '@/lib/calculations/menu';
import { loadRecipeAllergensByIds } from '@/lib/data/allergens';
import { listRecipesWithLines } from '@/lib/data/recipes';

/**
 * Menus / combos data layer (Sprint 10). Every function is org-scoped (RULE #1)
 * and runs inside the caller's `withOrg` transaction so RLS is active. Cost is
 * NEVER stored — it derives on read from the component recipes' current
 * `recipeCost` (lib/calculations).
 *
 * F4 BY CONSTRUCTION: there are two loader families with EXPLICIT projections.
 * `*Kitchen*` selects identity/notes/composition/availability/allergens only — it
 * never selects `menus.selling_price_cents`, recipe money, or ingredient prices,
 * and never invokes `recipeCost`. `*Manager*` selects the financial columns and
 * computes costs/KPIs. The kitchen DTO types cannot structurally hold money.
 */

// ── Shared (money-free) line + identity ──────────────────────────────────────

/** One menu line as both roles see it (no money). */
export type MenuLineBase = {
  /** menu_items row id. */
  id: string;
  recipeId: string;
  recipeName: string;
  quantity: number;
  sortOrder: number;
  /** False when the component recipe is trashed/missing → menu is incomplete. */
  available: boolean;
};

/** The menu's allergen rollup + provenance, shared by both roles. */
type MenuAllergenFields = {
  allergens: MenuAllergen[];
  hasUnreviewedIngredient: boolean;
};

// ── Kitchen DTOs (money keys are structurally absent) ─────────────────────────

export type KitchenMenuLine = MenuLineBase;

export type KitchenMenuListItem = MenuAllergenFields & {
  id: string;
  name: string;
  notes: string | null;
  itemCount: number;
  /** True when every component recipe is available. */
  complete: boolean;
};

export type KitchenMenuDetail = MenuAllergenFields & {
  id: string;
  name: string;
  notes: string | null;
  complete: boolean;
  lines: KitchenMenuLine[];
};

// ── Manager DTOs (carry the financial fields) ─────────────────────────────────

export type ManagerMenuLine = MenuLineBase & {
  /** This recipe's current cost per portion (cents); null when unavailable. */
  costPerPortionCents: number | null;
  /** costPerPortionCents × quantity; null when unavailable. */
  lineCostCents: number | null;
};

/** Derived monetary KPIs — every field is null when undefined (UI renders `—`). */
export type MenuKpis = {
  sellingPriceCents: number | null;
  /** Component cost (cents); null when the menu is incomplete. */
  costCents: number | null;
  foodCostPercent: number | null;
  marginPercent: number | null;
  trafficLight: MarginLight | null;
};

export type ManagerMenuListItem = MenuAllergenFields &
  MenuKpis & {
    id: string;
    name: string;
    notes: string | null;
    itemCount: number;
    complete: boolean;
    /** Recipe ids whose unavailability made the menu incomplete. */
    unavailableRecipeIds: string[];
  };

export type ManagerMenuDetail = MenuAllergenFields &
  MenuKpis & {
    id: string;
    name: string;
    notes: string | null;
    complete: boolean;
    unavailableRecipeIds: string[];
    lines: ManagerMenuLine[];
  };

// ── Base reads ────────────────────────────────────────────────────────────────

/** Active menus (newest first), identity rows only. */
export async function listMenus(
  db: TenantClient,
  organizationId: string,
): Promise<Menu[]> {
  return db
    .select()
    .from(menus)
    .where(and(eq(menus.organizationId, organizationId), isNull(menus.deletedAt)))
    .orderBy(menus.name);
}

/** One active menu by id, or null. */
export async function getMenuById(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Menu | null> {
  const rows = await db
    .select()
    .from(menus)
    .where(
      and(
        eq(menus.organizationId, organizationId),
        eq(menus.id, id),
        isNull(menus.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listTrashedMenus(
  db: TenantClient,
  organizationId: string,
): Promise<Menu[]> {
  return db
    .select()
    .from(menus)
    .where(
      and(eq(menus.organizationId, organizationId), isNotNull(menus.deletedAt)),
    )
    .orderBy(desc(menus.deletedAt));
}

/** Raw menu_items rows for a set of menus, ordered by (menu, sortOrder). */
type MenuItemRow = {
  id: string;
  menuId: string;
  recipeId: string;
  quantity: number;
  sortOrder: number;
};

async function loadMenuItems(
  db: TenantClient,
  organizationId: string,
  menuIds: string[],
): Promise<MenuItemRow[]> {
  if (menuIds.length === 0) return [];
  return db
    .select({
      id: menuItems.id,
      menuId: menuItems.menuId,
      recipeId: menuItems.recipeId,
      quantity: menuItems.quantity,
      sortOrder: menuItems.sortOrder,
    })
    .from(menuItems)
    .where(
      and(
        eq(menuItems.organizationId, organizationId),
        inArray(menuItems.menuId, menuIds),
      ),
    )
    .orderBy(asc(menuItems.menuId), asc(menuItems.sortOrder));
}

// ── Recipe resolution for menus (kitchen-safe vs manager-cost) ────────────────

type RecipeNameInfo = { name: string; available: boolean };
type RecipeCostInfo = RecipeNameInfo & { costPerPortionCents: number | null };

/**
 * Resolve recipe NAME + availability for a set of recipe ids, INCLUDING trashed
 * rows (so an unavailable line shows its name rather than silently disappearing).
 * Money-free — for kitchen loaders. A recipe id absent from the map is missing
 * entirely (treated as unavailable by the caller).
 */
async function loadRecipeNamesByIds(
  db: TenantClient,
  organizationId: string,
  recipeIds: string[],
): Promise<Map<string, RecipeNameInfo>> {
  const map = new Map<string, RecipeNameInfo>();
  if (recipeIds.length === 0) return map;
  const rows = await db
    .select({ id: recipes.id, name: recipes.name, deletedAt: recipes.deletedAt })
    .from(recipes)
    .where(
      and(eq(recipes.organizationId, organizationId), inArray(recipes.id, recipeIds)),
    );
  for (const r of rows) {
    map.set(r.id, { name: r.name, available: r.deletedAt === null });
  }
  return map;
}

/**
 * Resolve recipe name + availability + current cost per portion for a set of recipe
 * ids, INCLUDING trashed rows. A trashed/missing recipe yields
 * `costPerPortionCents = null` (and `available = false`) — it is NEVER costed as
 * zero (D5). Batched: one query for recipes, one for all their lines + ingredient
 * prices (ingredient join NOT `deleted_at`-filtered, mirroring recipeCost), then
 * `recipeCost` once per recipe. For MANAGER loaders only.
 */
async function costRecipesByIds(
  db: TenantClient,
  organizationId: string,
  recipeIds: string[],
): Promise<Map<string, RecipeCostInfo>> {
  const map = new Map<string, RecipeCostInfo>();
  if (recipeIds.length === 0) return map;

  const recipeRows = await db
    .select()
    .from(recipes)
    .where(
      and(eq(recipes.organizationId, organizationId), inArray(recipes.id, recipeIds)),
    );

  const lineRows = await db
    .select({
      recipeId: recipeIngredients.recipeId,
      quantity: recipeIngredients.quantity,
      dimension: ingredients.dimension,
      priceCents: ingredients.priceCents,
    })
    .from(recipeIngredients)
    .innerJoin(
      ingredients,
      and(
        eq(recipeIngredients.ingredientId, ingredients.id),
        eq(ingredients.organizationId, organizationId),
      ),
    )
    .where(
      and(
        eq(recipeIngredients.organizationId, organizationId),
        inArray(recipeIngredients.recipeId, recipeIds),
      ),
    );

  const linesByRecipe = new Map<string, RecipeCostLine[]>();
  for (const r of lineRows) {
    const line: RecipeCostLine = {
      dimension: r.dimension,
      priceCents: r.priceCents,
      quantity: Number(r.quantity),
    };
    const existing = linesByRecipe.get(r.recipeId);
    if (existing) existing.push(line);
    else linesByRecipe.set(r.recipeId, [line]);
  }

  for (const recipe of recipeRows) {
    const available = recipe.deletedAt === null;
    // A trashed component is unavailable → null cost (never zero). Only an active
    // recipe contributes a real per-portion cost.
    const costPerPortionCents = available
      ? recipeCost({
          yieldPortions: recipe.yieldPortions,
          yieldPercentage: recipe.yieldPercentage,
          laborCostCents: recipe.laborCostCents,
          energyCostCents: recipe.energyCostCents,
          packagingCostCents: recipe.packagingCostCents,
          lines: linesByRecipe.get(recipe.id) ?? [],
        }).costPerPortionCents
      : null;
    map.set(recipe.id, { name: recipe.name, available, costPerPortionCents });
  }
  return map;
}

/** Build the derived KPI bundle from a menu's cost result + selling price. */
function buildKpis(
  sellingPriceCents: number | null,
  complete: boolean,
  costCents: number | null,
): MenuKpis {
  const price =
    sellingPriceCents !== null && sellingPriceCents > 0 ? sellingPriceCents : null;
  const showMargin = complete && costCents !== null && price !== null;
  const margin = showMargin ? marginPercent(costCents, price) : null;
  return {
    sellingPriceCents,
    costCents: complete ? costCents : null,
    foodCostPercent: foodCostPercent(complete ? costCents : null, price),
    marginPercent: margin,
    trafficLight: margin !== null ? trafficLight(margin) : null,
  };
}

// ── Kitchen loaders ───────────────────────────────────────────────────────────

/** Money-free menu list for the kitchen role (composition + allergens only). */
export async function listKitchenMenus(
  db: TenantClient,
  organizationId: string,
): Promise<KitchenMenuListItem[]> {
  const menuRows = await listMenus(db, organizationId);
  if (menuRows.length === 0) return [];

  const items = await loadMenuItems(
    db,
    organizationId,
    menuRows.map((m) => m.id),
  );
  const recipeIds = [...new Set(items.map((i) => i.recipeId))];
  const [names, allergensByRecipe] = await Promise.all([
    loadRecipeNamesByIds(db, organizationId, recipeIds),
    loadRecipeAllergensByIds(db, organizationId, recipeIds),
  ]);

  const itemsByMenu = new Map<string, MenuItemRow[]>();
  for (const item of items) {
    const existing = itemsByMenu.get(item.menuId);
    if (existing) existing.push(item);
    else itemsByMenu.set(item.menuId, [item]);
  }

  return menuRows.map((menu) => {
    const menuLines = itemsByMenu.get(menu.id) ?? [];
    const complete = menuLines.every(
      (l) => names.get(l.recipeId)?.available ?? false,
    );
    const rollup = mergeMenuAllergens(
      menuLines.map((l) => allergensByRecipe.get(l.recipeId)).filter((r) => r != null),
    );
    return {
      id: menu.id,
      name: menu.name,
      notes: menu.notes,
      itemCount: menuLines.length,
      complete,
      allergens: rollup.allergens,
      hasUnreviewedIngredient: rollup.hasUnreviewedIngredient,
    };
  });
}

/** Money-free menu detail for the kitchen role. */
export async function getKitchenMenu(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<KitchenMenuDetail | null> {
  const menu = await getMenuById(db, organizationId, id);
  if (!menu) return null;

  const items = await loadMenuItems(db, organizationId, [menu.id]);
  const recipeIds = [...new Set(items.map((i) => i.recipeId))];
  const [names, allergensByRecipe] = await Promise.all([
    loadRecipeNamesByIds(db, organizationId, recipeIds),
    loadRecipeAllergensByIds(db, organizationId, recipeIds),
  ]);

  const lines: KitchenMenuLine[] = items.map((item) => {
    const info = names.get(item.recipeId);
    return {
      id: item.id,
      recipeId: item.recipeId,
      recipeName: info?.name ?? '',
      quantity: item.quantity,
      sortOrder: item.sortOrder,
      available: info?.available ?? false,
    };
  });
  const complete = lines.every((l) => l.available);
  const rollup = mergeMenuAllergens(
    items.map((i) => allergensByRecipe.get(i.recipeId)).filter((r) => r != null),
  );

  return {
    id: menu.id,
    name: menu.name,
    notes: menu.notes,
    complete,
    lines,
    allergens: rollup.allergens,
    hasUnreviewedIngredient: rollup.hasUnreviewedIngredient,
  };
}

// ── Manager loaders ─────────────────────────────────────────────────────────

/** Full menu list for the manager role (price/cost/food-cost/margin + allergens). */
export async function listManagerMenus(
  db: TenantClient,
  organizationId: string,
): Promise<ManagerMenuListItem[]> {
  const menuRows = await listMenus(db, organizationId);
  if (menuRows.length === 0) return [];

  const items = await loadMenuItems(
    db,
    organizationId,
    menuRows.map((m) => m.id),
  );
  const recipeIds = [...new Set(items.map((i) => i.recipeId))];
  const [costs, allergensByRecipe] = await Promise.all([
    costRecipesByIds(db, organizationId, recipeIds),
    loadRecipeAllergensByIds(db, organizationId, recipeIds),
  ]);

  const itemsByMenu = new Map<string, MenuItemRow[]>();
  for (const item of items) {
    const existing = itemsByMenu.get(item.menuId);
    if (existing) existing.push(item);
    else itemsByMenu.set(item.menuId, [item]);
  }

  return menuRows.map((menu) => {
    const menuLines = itemsByMenu.get(menu.id) ?? [];
    const costLines: MenuCostLine[] = menuLines.map((l) => ({
      recipeId: l.recipeId,
      quantity: l.quantity,
      costPerPortionCents: costs.get(l.recipeId)?.costPerPortionCents ?? null,
    }));
    const cost = menuCost(costLines);
    const rollup = mergeMenuAllergens(
      menuLines.map((l) => allergensByRecipe.get(l.recipeId)).filter((r) => r != null),
    );
    return {
      id: menu.id,
      name: menu.name,
      notes: menu.notes,
      itemCount: menuLines.length,
      complete: cost.complete,
      unavailableRecipeIds: cost.complete ? [] : cost.unavailableRecipeIds,
      allergens: rollup.allergens,
      hasUnreviewedIngredient: rollup.hasUnreviewedIngredient,
      ...buildKpis(menu.sellingPriceCents, cost.complete, cost.costCents),
    };
  });
}

/** Full menu detail for the manager role, including per-line costs. */
export async function getManagerMenu(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<ManagerMenuDetail | null> {
  const menu = await getMenuById(db, organizationId, id);
  if (!menu) return null;

  const items = await loadMenuItems(db, organizationId, [menu.id]);
  const recipeIds = [...new Set(items.map((i) => i.recipeId))];
  const [costs, allergensByRecipe] = await Promise.all([
    costRecipesByIds(db, organizationId, recipeIds),
    loadRecipeAllergensByIds(db, organizationId, recipeIds),
  ]);

  const lines: ManagerMenuLine[] = items.map((item) => {
    const info = costs.get(item.recipeId);
    const costPerPortionCents = info?.costPerPortionCents ?? null;
    return {
      id: item.id,
      recipeId: item.recipeId,
      recipeName: info?.name ?? '',
      quantity: item.quantity,
      sortOrder: item.sortOrder,
      available: info?.available ?? false,
      costPerPortionCents,
      lineCostCents:
        costPerPortionCents === null ? null : costPerPortionCents * item.quantity,
    };
  });

  const cost = menuCost(
    items.map((l) => ({
      recipeId: l.recipeId,
      quantity: l.quantity,
      costPerPortionCents: costs.get(l.recipeId)?.costPerPortionCents ?? null,
    })),
  );
  const rollup = mergeMenuAllergens(
    items.map((i) => allergensByRecipe.get(i.recipeId)).filter((r) => r != null),
  );

  return {
    id: menu.id,
    name: menu.name,
    notes: menu.notes,
    complete: cost.complete,
    unavailableRecipeIds: cost.complete ? [] : cost.unavailableRecipeIds,
    lines,
    allergens: rollup.allergens,
    hasUnreviewedIngredient: rollup.hasUnreviewedIngredient,
    ...buildKpis(menu.sellingPriceCents, cost.complete, cost.costCents),
  };
}

/** An active recipe the manager editor can add to a menu (name + per-portion cost). */
export type MenuRecipeOption = {
  id: string;
  name: string;
  costPerPortionCents: number;
};

/**
 * Active recipes as menu-editor options, each with its current cost per portion
 * (MANAGER-only — carries money). Reuses `listRecipesWithLines` + `recipeCost`, so
 * the picker's live menu cost matches the saved menu's derived cost exactly.
 */
export async function listMenuRecipeOptions(
  db: TenantClient,
  organizationId: string,
): Promise<MenuRecipeOption[]> {
  const recipesWithLines = await listRecipesWithLines(db, organizationId);
  return recipesWithLines.map(({ recipe, lines }) => ({
    id: recipe.id,
    name: recipe.name,
    costPerPortionCents: recipeCost({
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
    }).costPerPortionCents,
  }));
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/** A validated menu line for create/update (recipe + portion quantity). */
export type MenuItemInput = { recipeId: string; quantity: number };

/** The menu's own fields (no items) for create/update. */
export type MenuFields = {
  name: string;
  sellingPriceCents: number | null;
  notes: string | null;
};

export type CreateMenuOutcome =
  | { status: 'ok'; menu: Menu }
  | { status: 'invalid_recipe' };

export type UpdateMenuOutcome =
  | { status: 'ok'; menu: Menu }
  | { status: 'not_found' }
  | { status: 'invalid_recipe' };

/**
 * Lock the supplied recipe ids FOR UPDATE in id-ascending order (deadlock-free),
 * returning true only when EVERY id resolves to an ACTIVE, same-org recipe. The
 * lock serializes against a concurrent recipe trash (which locks the same rows), so
 * a menu can never capture a recipe that is being trashed in a racing transaction.
 */
async function lockActiveRecipesForMenu(
  db: TenantClient,
  organizationId: string,
  recipeIds: string[],
): Promise<boolean> {
  if (recipeIds.length === 0) return false;
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
  return locked.length === recipeIds.length;
}

/** Insert the menu's lines, sort_order = array index. */
async function insertMenuItems(
  db: TenantClient,
  organizationId: string,
  menuId: string,
  items: MenuItemInput[],
): Promise<void> {
  await db.insert(menuItems).values(
    items.map((item, index) => ({
      organizationId,
      menuId,
      recipeId: item.recipeId,
      quantity: item.quantity,
      sortOrder: index,
    })),
  );
}

/**
 * Create a menu + its lines in one transaction. The caller has validated that
 * `items` is non-empty with DISTINCT recipe ids; here we lock + assert every recipe
 * is active/same-org (else `invalid_recipe`, no write), then insert.
 */
export async function createMenu(
  db: TenantClient,
  organizationId: string,
  fields: MenuFields,
  items: MenuItemInput[],
): Promise<CreateMenuOutcome> {
  const recipeIds = items.map((i) => i.recipeId);
  if (!(await lockActiveRecipesForMenu(db, organizationId, recipeIds))) {
    return { status: 'invalid_recipe' };
  }

  const [menu] = await db
    .insert(menus)
    .values({
      organizationId,
      name: fields.name,
      sellingPriceCents: fields.sellingPriceCents,
      notes: fields.notes,
    })
    .returning();
  if (!menu) throw new Error('Failed to create menu.');

  await insertMenuItems(db, organizationId, menu.id, items);
  return { status: 'ok', menu };
}

/**
 * Replace an active menu's fields + lines in one transaction. Locks the menu row
 * and reasserts it is active (else `not_found`), then locks/validates the recipes
 * (else `invalid_recipe`), then rewrites the fields and the full item set.
 */
export async function updateMenu(
  db: TenantClient,
  organizationId: string,
  id: string,
  fields: MenuFields,
  items: MenuItemInput[],
): Promise<UpdateMenuOutcome> {
  // Lock + reassert the menu is active before touching it (serializes vs trash).
  const menuLock = await db
    .select({ id: menus.id })
    .from(menus)
    .where(
      and(
        eq(menus.organizationId, organizationId),
        eq(menus.id, id),
        isNull(menus.deletedAt),
      ),
    )
    .for('update');
  if (menuLock.length === 0) return { status: 'not_found' };

  const recipeIds = items.map((i) => i.recipeId);
  if (!(await lockActiveRecipesForMenu(db, organizationId, recipeIds))) {
    return { status: 'invalid_recipe' };
  }

  const [menu] = await db
    .update(menus)
    .set({
      name: fields.name,
      sellingPriceCents: fields.sellingPriceCents,
      notes: fields.notes,
    })
    .where(
      and(
        eq(menus.organizationId, organizationId),
        eq(menus.id, id),
        isNull(menus.deletedAt),
      ),
    )
    .returning();
  if (!menu) return { status: 'not_found' };

  await db
    .delete(menuItems)
    .where(
      and(eq(menuItems.organizationId, organizationId), eq(menuItems.menuId, id)),
    );
  await insertMenuItems(db, organizationId, id, items);

  return { status: 'ok', menu };
}

/** Move an active menu to the trash. Returns null if it was not active. */
export async function softDeleteMenu(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Menu | null> {
  const [row] = await db
    .update(menus)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(menus.organizationId, organizationId),
        eq(menus.id, id),
        isNull(menus.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/** Bring a trashed menu back. Returns null if it was not in the trash. */
export async function restoreMenu(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Menu | null> {
  const [row] = await db
    .update(menus)
    .set({ deletedAt: null })
    .where(
      and(
        eq(menus.organizationId, organizationId),
        eq(menus.id, id),
        isNotNull(menus.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Permanently delete a trashed menu; its lines cascade via the composite FK (which
 * frees any recipe those lines pinned via the restrict FK). Only trashed rows are
 * eligible.
 */
export async function purgeMenu(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<void> {
  await db
    .delete(menus)
    .where(
      and(
        eq(menus.organizationId, organizationId),
        eq(menus.id, id),
        isNotNull(menus.deletedAt),
      ),
    );
}

/**
 * How many menu_items rows reference a recipe — across ALL menus regardless of the
 * menu's own trashed state (the restrict FK blocks the recipe purge either way).
 * The recipe-purge guard reads this BEFORE any side effect.
 */
export async function countMenusUsingRecipe(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(menuItems)
    .where(
      and(
        eq(menuItems.organizationId, organizationId),
        eq(menuItems.recipeId, recipeId),
      ),
    );
  return rows[0]?.value ?? 0;
}
