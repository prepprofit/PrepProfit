import { and, asc, count, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { validateFolderMove, folderLabel, type FolderMoveRejection } from '@/lib/folders/tree';
import {
  ingredients,
  menuExtras,
  menuFolders,
  menuIngredientItems,
  menuItems,
  menus,
  recipes,
} from '@/lib/db/schema';
import type { Menu, MenuFolder } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import type { Dimension } from '@/lib/units';
import { costPerKgCents } from '@/lib/calculations/recipeCost';
import {
  compositionCost,
  dishPricing,
  ingredientCanonicalQuantity,
  ingredientDisplayAmount,
  isIngredientUnitFor,
  outputCanonicalQuantity,
  outputDisplayAmount,
  type DishIngredientUnit,
  type DishOutputUnit,
  type DishRecipeUnit,
  type PriceBasis,
} from '@/lib/calculations/dish';
import { mergeMenuAllergens, type MenuAllergen } from '@/lib/calculations/menu';
import type { RecipeAllergenRollup } from '@/lib/calculations/allergens';
import {
  catalogueDishLookups,
  catalogueRecipeCosts,
  loadActiveCatalogue,
} from '@/lib/data/active-catalogue';
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

export type MenuFolderSummary = { id: string; name: string; parentId: string | null; dishCount: number };

/**
 * Every folder in the org (any level, name order) with its DIRECT active-dish
 * count, plus how many active dishes are unfiled. Returns the FULL flat org
 * tree — callers use lib/folders/tree.ts to derive one level's children, an
 * ancestor breadcrumb, or the valid move targets.
 */
export async function listMenuFolders(
  db: TenantClient,
  organizationId: string,
): Promise<{ folders: MenuFolderSummary[]; unfiledCount: number }> {
  const [folderRows, countRows] = await Promise.all([
    db
      .select({ id: menuFolders.id, name: menuFolders.name, parentId: menuFolders.parentId })
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
    folders: folderRows.map((f) => ({
      id: f.id,
      name: f.name,
      parentId: f.parentId,
      dishCount: counts.get(f.id) ?? 0,
    })),
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
): Promise<{ id: string; name: string; parentId: string | null }[]> {
  return db
    .select({ id: menuFolders.id, name: menuFolders.name, parentId: menuFolders.parentId })
    .from(menuFolders)
    .where(eq(menuFolders.organizationId, organizationId))
    .orderBy(asc(menuFolders.name));
}

/** Throws a unique violation on a duplicate name within the same parent (the action maps it). */
export async function createMenuFolder(
  db: TenantClient,
  organizationId: string,
  name: string,
  parentId: string | null = null,
): Promise<MenuFolder> {
  const [row] = await db.insert(menuFolders).values({ organizationId, name, parentId }).returning();
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

export type MoveMenuFolderResult =
  | { ok: true; previousParentId: string | null }
  | { ok: false; reason: FolderMoveRejection };

/**
 * Reparents a folder. Locks every folder row of the org FOR UPDATE (id order,
 * deadlock-free) so two concurrent moves in the same org serialize instead of
 * racing into a cycle. Rejects a self-move or a move into one of the folder's
 * own descendants (lib/folders/tree.ts, checked against the just-locked
 * snapshot). A same-name collision at the destination surfaces as the DB's
 * existing partial-unique-index violation, same as create/rename.
 */
export async function moveMenuFolder(
  db: TenantClient,
  organizationId: string,
  id: string,
  newParentId: string | null,
): Promise<MoveMenuFolderResult> {
  const rows = await db
    .select({ id: menuFolders.id, name: menuFolders.name, parentId: menuFolders.parentId })
    .from(menuFolders)
    .where(eq(menuFolders.organizationId, organizationId))
    .orderBy(asc(menuFolders.id))
    .for('update');

  const rejection = validateFolderMove(rows, id, newParentId);
  if (rejection) return { ok: false, reason: rejection };

  const previousParentId = rows.find((f) => f.id === id)!.parentId;
  await db
    .update(menuFolders)
    .set({ parentId: newParentId })
    .where(and(eq(menuFolders.organizationId, organizationId), eq(menuFolders.id, id)));

  return { ok: true, previousParentId };
}

/**
 * Delete a folder; its DIRECT dishes (active AND trashed) move to Unfiled first,
 * so the restrict FK never blocks and a later restore lands somewhere visible.
 * Blocked (no write happens) while the folder still has subfolders — never
 * silently drops a nested subtree.
 */
export async function deleteMenuFolder(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<{ deleted: boolean; movedDishes: number; blockedBySubfolders: boolean }> {
  const [child] = await db
    .select({ id: menuFolders.id })
    .from(menuFolders)
    .where(and(eq(menuFolders.organizationId, organizationId), eq(menuFolders.parentId, id)))
    .limit(1);
  if (child) return { deleted: false, movedDishes: 0, blockedBySubfolders: true };

  const moved = await db
    .update(menus)
    .set({ folderId: null })
    .where(and(eq(menus.organizationId, organizationId), eq(menus.folderId, id)))
    .returning({ id: menus.id });
  const deleted = await db
    .delete(menuFolders)
    .where(and(eq(menuFolders.organizationId, organizationId), eq(menuFolders.id, id)))
    .returning({ id: menuFolders.id });
  return { deleted: deleted.length > 0, movedDishes: moved.length, blockedBySubfolders: false };
}

// ── Search (money-free; both roles) ──────────────────────────────────────────

export type DishSearchResult = { id: string; name: string; folderPath: string | null };

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Every active dish in the org by name — typo tolerant, regardless of folder
 * depth. `folderPath` is the FULL "Wibox › Linda" breadcrumb (not just the
 * immediate folder), built in-memory from the small per-org folder list so
 * nesting needs no recursive SQL here either.
 */
export async function searchDishes(
  db: TenantClient,
  organizationId: string,
  query: string,
  limit = 20,
): Promise<DishSearchResult[]> {
  const like = `%${escapeLike(query)}%`;
  const [rows, folders] = await Promise.all([
    db
      .select({ id: menus.id, name: menus.name, folderId: menus.folderId })
      .from(menus)
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
      .limit(limit),
    db
      .select({ id: menuFolders.id, name: menuFolders.name, parentId: menuFolders.parentId })
      .from(menuFolders)
      .where(eq(menuFolders.organizationId, organizationId)),
  ]);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    folderPath: r.folderId ? folderLabel(folders, r.folderId) || null : null,
  }));
}

// ── Shared shapes ────────────────────────────────────────────────────────────

/** "This batch makes": amount in `unit` (converted from canonical), plus size text. */
export type DishOutputView = {
  quantity: number;
  unit: DishOutputUnit;
  sizeDescription: string | null;
  /** Count batches only; grams. */
  finishedWeightGrams: number | null;
};

function outputView(row: Menu): DishOutputView {
  return {
    quantity: outputDisplayAmount(row.outputQuantity, row.outputUnit),
    unit: row.outputUnit,
    sizeDescription: row.sizeDescription,
    finishedWeightGrams: row.finishedWeightGrams,
  };
}

// ── Folder view: dish list ───────────────────────────────────────────────────

export type DishListItem = {
  id: string;
  name: string;
  output: DishOutputView;
  componentCount: number;
  createdAt: Date;
  updatedAt: Date;
  lastOpenedAt: Date | null;
};

export type ManagerDishListItem = DishListItem & {
  sellingPriceCents: number | null;
  priceBasis: PriceBasis;
  /** Per kg (weight) or per output unit (count). */
  costPerSaleUnitCents: number | null;
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

function listItem(row: Menu, componentCount: Map<string, number>): DishListItem {
  return {
    id: row.id,
    name: row.name,
    output: outputView(row),
    componentCount: componentCount.get(row.id) ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastOpenedAt: row.lastOpenedAt,
  };
}

export async function listKitchenDishes(
  db: TenantClient,
  organizationId: string,
  folderId: string | null,
  sort: DishSort,
): Promise<DishListItem[]> {
  const { rows, componentCount } = await listDishRows(db, organizationId, folderId, sort);
  return rows.map((r) => listItem(r, componentCount));
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
  const lookups = catalogueDishLookups(catalogue);
  const menuById = new Map(catalogue.menus.map((m) => [m.id, m]));

  return rows.map((r) => {
    const composition = menuById.get(r.id);
    const cost = composition ? compositionCost(composition, lookups) : null;
    return {
      ...listItem(r, componentCount),
      sellingPriceCents: r.sellingPriceCents,
      priceBasis: r.priceBasis,
      costPerSaleUnitCents: cost?.costPerSaleUnitCents ?? null,
      marginBps: cost ? dishPricing(cost, r.sellingPriceCents, 0).marginBps : null,
    };
  });
}

// ── Dish detail ──────────────────────────────────────────────────────────────

type DishIdentity = {
  id: string;
  name: string;
  folderId: string | null;
  output: DishOutputView;
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

/** Money-free: no price, labour, hourly rates or expenses. */
export type KitchenDishDetail = DishIdentity & {
  recipeLines: KitchenDishRecipeLine[];
  ingredientLines: KitchenDishIngredientLine[];
  allergens: MenuAllergen[];
  hasUnreviewedIngredient: boolean;
};

export type DishExtraView =
  | { kind: 'work'; description: string; hours: number; hourlyCents: number }
  | { kind: 'expense'; description: string; amountCents: number };

export type ManagerDishDetail = DishIdentity & {
  sellingPriceCents: number | null;
  priceBasis: PriceBasis;
  vatRateBps: number | null;
  labour: { hours: number; hourlyCents: number } | null;
  extras: DishExtraView[];
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

async function loadDishExtras(
  db: TenantClient,
  organizationId: string,
  menuId: string,
): Promise<DishExtraView[]> {
  const rows = await db
    .select()
    .from(menuExtras)
    .where(and(eq(menuExtras.organizationId, organizationId), eq(menuExtras.menuId, menuId)))
    .orderBy(asc(menuExtras.sortOrder));
  const out: DishExtraView[] = [];
  for (const r of rows) {
    if (r.kind === 'work' && r.hours !== null && r.hourlyCents !== null) {
      out.push({ kind: 'work', description: r.description, hours: r.hours, hourlyCents: r.hourlyCents });
    } else if (r.kind === 'expense' && r.amountCents !== null) {
      out.push({ kind: 'expense', description: r.description, amountCents: r.amountCents });
    }
  }
  return out;
}

export async function getManagerDish(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<ManagerDishDetail | null> {
  const menu = await getMenuById(db, organizationId, id);
  if (!menu) return null;
  const [lines, extras] = await Promise.all([
    loadDishLines(db, organizationId, id),
    loadDishExtras(db, organizationId, id),
  ]);
  return {
    id: menu.id,
    name: menu.name,
    folderId: menu.folderId,
    output: outputView(menu),
    notes: menu.notes,
    sellingPriceCents: menu.sellingPriceCents,
    priceBasis: menu.priceBasis,
    vatRateBps: menu.vatRateBps,
    labour:
      menu.labourHours !== null && menu.labourHourlyCents !== null
        ? { hours: menu.labourHours, hourlyCents: menu.labourHourlyCents }
        : null,
    extras,
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
  const ingredientIds = lines.ingredientLines.map((l) => l.ingredientId);
  const [recipeAllergens, ingredientAllergens, reviewRows] = await Promise.all([
    loadRecipeAllergensByIds(db, organizationId, lines.recipeLines.map((l) => l.recipeId)),
    loadIngredientAllergensByIngredient(db, organizationId, ingredientIds),
    ingredientIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ id: ingredients.id, reviewedAt: ingredients.allergensReviewedAt })
          .from(ingredients)
          .where(and(eq(ingredients.organizationId, organizationId), inArray(ingredients.id, ingredientIds))),
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
    output: outputView(menu),
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
  /** The same cost without the recipe's own and nested sub-recipe labour. */
  costPerPortionWithoutLabourCents: number | null;
  costPerKgCents: number | null;
  costPerKgWithoutLabourCents: number | null;
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
  const costs = catalogueRecipeCosts(catalogue);
  return {
    recipes: catalogue.recipes
      .map((r) => {
        const c = costs.get(r.id);
        return {
          id: r.id,
          name: r.name,
          yieldPortions: r.yieldPortions,
          yieldWeightGrams: r.yieldWeightGrams,
          costPerPortionCents: c?.withLabour ?? null,
          costPerPortionWithoutLabourCents: c?.withoutLabour ?? null,
          costPerKgCents: c?.totalWithLabour != null ? costPerKgCents(c.totalWithLabour, r.yieldWeightGrams) : null,
          costPerKgWithoutLabourCents:
            c?.totalWithoutLabour != null ? costPerKgCents(c.totalWithoutLabour, r.yieldWeightGrams) : null,
        };
      })
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

/** A dish's stored recipe lines as saved (unit + amount in that unit). */
export async function loadStoredRecipeLines(
  db: TenantClient,
  organizationId: string,
  menuId: string,
): Promise<{ recipeId: string; quantity: number; unit: DishRecipeUnit }[]> {
  return db
    .select({ recipeId: menuItems.recipeId, quantity: menuItems.quantity, unit: menuItems.unit })
    .from(menuItems)
    .where(and(eq(menuItems.organizationId, organizationId), eq(menuItems.menuId, menuId)));
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

async function insertDishChildren(
  db: TenantClient,
  organizationId: string,
  menuId: string,
  input: Pick<DishFormInput, 'recipeLines' | 'ingredientLines' | 'extras'>,
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
  if (input.extras.length > 0) {
    await db.insert(menuExtras).values(
      input.extras.map((extra, index) => ({
        organizationId,
        menuId,
        kind: extra.kind,
        description: extra.description,
        hours: extra.kind === 'work' ? extra.hours : null,
        hourlyCents: extra.kind === 'work' ? extra.hourlyCents : null,
        amountCents: extra.kind === 'expense' ? extra.amountCents : null,
        sortOrder: index,
      })),
    );
  }
}

function dishFields(input: DishFormInput) {
  return {
    name: input.name,
    folderId: input.folderId,
    outputQuantity: outputCanonicalQuantity(input.output.quantity, input.output.unit),
    outputUnit: input.output.unit,
    sizeDescription: input.output.sizeDescription ?? null,
    finishedWeightGrams: input.output.finishedWeightGrams,
    sellingPriceCents: input.sellingPriceCents,
    priceBasis: input.priceBasis,
    vatRateBps: input.vatRateBps,
    labourHours: input.labour?.hours ?? null,
    labourHourlyCents: input.labour?.hourlyCents ?? null,
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
  await insertDishChildren(db, organizationId, menu.id, input);
  return { status: 'ok', menu };
}

/** Replace an active product's fields + full composition + extras in one transaction. */
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
  await db
    .delete(menuExtras)
    .where(and(eq(menuExtras.organizationId, organizationId), eq(menuExtras.menuId, id)));
  await insertDishChildren(db, organizationId, id, input);
  return { status: 'ok', menu };
}

/**
 * "Make a copy": an independent product with the same composition, output, size,
 * finished weight, labour, extras, price + basis, VAT, folder and notes. Children are
 * copied row-for-row (canonical quantities stay exact); the original is untouched.
 */
export async function duplicateDish(
  db: TenantClient,
  organizationId: string,
  id: string,
  name: string,
): Promise<{ status: 'ok'; menu: Menu } | { status: 'not_found' }> {
  const source = await getMenuById(db, organizationId, id);
  if (!source) return { status: 'not_found' };
  const [menu] = await db
    .insert(menus)
    .values({
      organizationId,
      name,
      folderId: source.folderId,
      outputQuantity: source.outputQuantity,
      outputUnit: source.outputUnit,
      sizeDescription: source.sizeDescription,
      finishedWeightGrams: source.finishedWeightGrams,
      sellingPriceCents: source.sellingPriceCents,
      priceBasis: source.priceBasis,
      vatRateBps: source.vatRateBps,
      labourHours: source.labourHours,
      labourHourlyCents: source.labourHourlyCents,
      notes: source.notes,
      lastOpenedAt: new Date(),
    })
    .returning();
  if (!menu) throw new Error('Failed to copy dish.');

  const scopeItems = (table: typeof menuItems | typeof menuIngredientItems | typeof menuExtras) =>
    and(eq(table.organizationId, organizationId), eq(table.menuId, id));
  const [recipeRows, ingredientRows, extraRows] = await Promise.all([
    db.select().from(menuItems).where(scopeItems(menuItems)),
    db.select().from(menuIngredientItems).where(scopeItems(menuIngredientItems)),
    db.select().from(menuExtras).where(scopeItems(menuExtras)),
  ]);
  if (recipeRows.length > 0) {
    await db.insert(menuItems).values(
      recipeRows.map(({ id: _id, menuId: _menuId, ...row }) => ({ ...row, menuId: menu.id })),
    );
  }
  if (ingredientRows.length > 0) {
    await db.insert(menuIngredientItems).values(
      ingredientRows.map(({ id: _id, menuId: _menuId, ...row }) => ({ ...row, menuId: menu.id })),
    );
  }
  if (extraRows.length > 0) {
    await db.insert(menuExtras).values(
      extraRows.map(({ id: _id, menuId: _menuId, ...row }) => ({ ...row, menuId: menu.id })),
    );
  }
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

/** Permanently delete a trashed dish; lines and extras cascade via composite FKs. */
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
