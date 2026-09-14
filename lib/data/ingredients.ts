import { and, count, countDistinct, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  ingredients,
  inventoryMovements,
  menuIngredientItems,
  menus,
  recipeIngredients,
  recipes,
} from '@/lib/db/schema';
import type { Ingredient, NewIngredient } from '@/lib/db/schema';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { TenantClient } from '@/lib/db/tenant';
import { nullTaskIngredientLinks } from '@/lib/data/tasks';

/**
 * Access to `ingredients` is ALWAYS scoped by `organizationId` (application
 * layer, primary defense). The `organizationId` is injected by the server —
 * never trust the client. RLS (lib/db/rls.ts) is the second layer.
 *
 * Soft-delete: rows carry `deleted_at` (NULL = active). Every active read filters
 * `deleted_at IS NULL`; trashed rows surface only through the trash-scoped reads
 * below. See lib/trash.ts for the retention window and lib/data/trash.ts for the
 * auto-purge.
 */

export type IngredientInput = Omit<
  NewIngredient,
  'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

/**
 * Kitchen-facing ingredient shape (Sprint F4): the full row with the financial
 * columns (`priceCents`, `pendingPriceCents`) OMITTED — the keys are literally
 * absent, not zeroed, so a kitchen payload can never carry a cost. Built with
 * {@link toKitchenIngredient}. Pages/actions ship this to kitchen instead of the
 * full `Ingredient` (UI hiding alone is never enough — CLAUDE.md).
 */
export type KitchenIngredient = Omit<Ingredient, 'priceCents' | 'pendingPriceCents'>;

/** Strips the financial columns from an ingredient row for a kitchen payload. */
export function toKitchenIngredient(row: Ingredient): KitchenIngredient {
  const { priceCents: _priceCents, pendingPriceCents: _pendingPriceCents, ...rest } =
    row;
  return rest;
}

/** Active ingredients still flagged `needs_pricing` — feeds the sidebar badge. */
export async function countNeedsPricing(
  db: TenantClient,
  organizationId: string,
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        isNull(ingredients.deletedAt),
        eq(ingredients.needsPricing, true),
      ),
    );
  return row?.value ?? 0;
}

export async function listIngredients(
  db: TenantClient,
  organizationId: string,
): Promise<Ingredient[]> {
  return db
    .select()
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        isNull(ingredients.deletedAt),
      ),
    )
    .orderBy(ingredients.name);
}

/**
 * A lightweight ingredient option for the recipe-import resolution search (Sprint
 * 4.7): id + display name + dimension only — never a price/cost. The dimension lets
 * the inline match UI hint (and the server reject) a dimension-incompatible link.
 */
export type IngredientOption = {
  id: string;
  name: string;
  dimension: Ingredient['dimension'];
};

/**
 * All ACTIVE ingredients as `{ id, name, dimension }` options, ordered by name, for
 * the recipe-import inline ingredient search. Org-scoped (Rule 1); carries no money.
 */
export async function listIngredientOptions(
  db: TenantClient,
  organizationId: string,
): Promise<IngredientOption[]> {
  return db
    .select({
      id: ingredients.id,
      name: ingredients.name,
      dimension: ingredients.dimension,
    })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        isNull(ingredients.deletedAt),
      ),
    )
    .orderBy(ingredients.name);
}

export async function getIngredientById(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Ingredient | null> {
  const rows = await db
    .select()
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, id),
        isNull(ingredients.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function createIngredient(
  db: TenantClient,
  organizationId: string,
  input: IngredientInput,
): Promise<Ingredient> {
  const [row] = await db
    .insert(ingredients)
    .values({ ...input, organizationId })
    .returning();
  if (!row) throw new Error('Failed to create ingredient.');
  return row;
}

export async function updateIngredient(
  db: TenantClient,
  organizationId: string,
  id: string,
  input: IngredientInput,
): Promise<Ingredient | null> {
  const [row] = await db
    .update(ingredients)
    .set(input)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, id),
        // A trashed ingredient must be restored before it can be edited.
        isNull(ingredients.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * How many ACTIVE (non-trashed) recipes still use this ingredient. The trash
 * action blocks soft-deleting an ingredient while this is > 0, preserving the
 * invariant that an active recipe never references a trashed ingredient (so
 * recipe costs never change silently). Lines of already-trashed recipes do not
 * count.
 */
export async function countActiveRecipesUsingIngredient(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(recipeIngredients)
    .innerJoin(
      recipes,
      and(
        eq(recipeIngredients.recipeId, recipes.id),
        eq(recipes.organizationId, organizationId),
      ),
    )
    .where(
      and(
        eq(recipeIngredients.organizationId, organizationId),
        eq(recipeIngredients.ingredientId, ingredientId),
        isNull(recipes.deletedAt),
      ),
    );
  return rows[0]?.value ?? 0;
}

/**
 * Takes a FOR UPDATE lock on an active ingredient row, returning whether one
 * exists. `deleteIngredientAction` calls this before its in-use check, and
 * `addRecipeIngredient` locks the same row before wiring a line — so the two
 * flows serialize on this row and the "active recipe references only active
 * ingredients" invariant can't be raced under READ COMMITTED.
 */
export async function lockActiveIngredient(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: ingredients.id })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, id),
        isNull(ingredients.deletedAt),
      ),
    )
    .for('update')
    .limit(1);
  return rows.length > 0;
}

/**
 * Like {@link lockActiveIngredient}, but returns the FULL locked row (or null).
 * The F2 pricing flows (record observation / accept cost / manual price edit) take
 * this FOR UPDATE lock so they serialize on the ingredient — a concurrent observe
 * and accept can't race and accept the wrong "latest" history line.
 */
export async function lockActiveIngredientRow(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Ingredient | null> {
  const rows = await db
    .select()
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, id),
        isNull(ingredients.deletedAt),
      ),
    )
    .for('update')
    .limit(1);
  return rows[0] ?? null;
}

/** Moves an active ingredient to the trash. Returns null if it was not active. */
export async function softDeleteIngredient(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Ingredient | null> {
  const [row] = await db
    .update(ingredients)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, id),
        isNull(ingredients.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/** What still uses an ingredient: counts plus a few names to show the user. */
export type IngredientUsage = {
  recipeCount: number;
  recipeNames: string[];
  menuCount: number;
  menuNames: string[];
};

/** Outcome of {@link trashIngredient}. */
export type TrashIngredientOutcome =
  | { status: 'done' }
  | { status: 'in_use'; inUse: number; usage: IngredientUsage }
  | { status: 'not_found' };

const USAGE_NAME_LIMIT = 5;

/** Active recipes and dishes that use an ingredient (names A→Z, first few only). */
export async function loadIngredientUsage(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
): Promise<IngredientUsage> {
  const [recipeRows, menuRows] = await Promise.all([
    db
      .selectDistinct({ id: recipes.id, name: recipes.name })
      .from(recipeIngredients)
      .innerJoin(recipes, and(eq(recipes.organizationId, organizationId), eq(recipes.id, recipeIngredients.recipeId)))
      .where(
        and(
          eq(recipeIngredients.organizationId, organizationId),
          eq(recipeIngredients.ingredientId, ingredientId),
          isNull(recipes.deletedAt),
        ),
      ),
    db
      .selectDistinct({ id: menus.id, name: menus.name })
      .from(menuIngredientItems)
      .innerJoin(menus, and(eq(menus.organizationId, organizationId), eq(menus.id, menuIngredientItems.menuId)))
      .where(
        and(
          eq(menuIngredientItems.organizationId, organizationId),
          eq(menuIngredientItems.ingredientId, ingredientId),
          isNull(menus.deletedAt),
        ),
      ),
  ]);
  const names = (rows: { name: string }[]) =>
    rows
      .map((r) => r.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, USAGE_NAME_LIMIT);
  return {
    recipeCount: recipeRows.length,
    recipeNames: names(recipeRows),
    menuCount: menuRows.length,
    menuNames: names(menuRows),
  };
}

/**
 * The full "move an ingredient to the trash" transaction, as a data-layer service
 * so it is testable without Clerk/cache (deleteIngredientAction is a thin wrapper).
 * MUST run inside a `withOrg`/`runInOrg` transaction: it locks the active row FOR
 * UPDATE, refuses if any ACTIVE recipe still uses it, then soft-deletes — all
 * serialized against `addRecipeIngredient` (which takes the same lock), so the
 * active-recipe-references-only-active-ingredient invariant holds under real
 * Postgres concurrency.
 */
export async function trashIngredient(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<TrashIngredientOutcome> {
  if (!(await lockActiveIngredient(db, organizationId, id))) {
    return { status: 'not_found' };
  }
  const inUse =
    (await countActiveRecipesUsingIngredient(db, organizationId, id)) +
    (await countActiveMenusUsingIngredient(db, organizationId, id));
  if (inUse > 0) {
    return { status: 'in_use', inUse, usage: await loadIngredientUsage(db, organizationId, id) };
  }
  const row = await softDeleteIngredient(db, organizationId, id);
  return row ? { status: 'done' } : { status: 'not_found' };
}

/** Brings a trashed ingredient back. Returns null if it was not in the trash. */
export async function restoreIngredient(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Ingredient | null> {
  const [row] = await db
    .update(ingredients)
    .set({ deletedAt: null })
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, id),
        isNotNull(ingredients.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Permanently deletes a trashed ingredient. Only trashed rows are eligible (an
 * active row can never be hard-deleted here). The composite FK on
 * `recipe_ingredients` is `ON DELETE restrict`, so an ingredient still pinned by
 * a (trashed) recipe's line raises a foreign-key violation — callers surface that.
 */
export async function purgeIngredient(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<void> {
  // Null any reorder-task link pointing at this ingredient (→ plain text) before the
  // delete, so the `tasks_source_ingredient_fk` restrict FK never blocks (Sprint 6
  // L4). If another restrict FK (a trashed recipe line) still blocks, the whole tx
  // rolls back and this unlink is undone with it.
  await nullTaskIngredientLinks(db, organizationId, [id]);

  await db
    .delete(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, id),
        isNotNull(ingredients.deletedAt),
      ),
    );
}

export async function listTrashedIngredients(
  db: TenantClient,
  organizationId: string,
): Promise<Ingredient[]> {
  return db
    .select()
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        isNotNull(ingredients.deletedAt),
      ),
    )
    .orderBy(desc(ingredients.deletedAt));
}

/**
 * ACTIVE dishes using an ingredient as a direct line (Dish Builder). Like an active
 * recipe, an active dish blocks trashing the ingredient — its cost would silently
 * become unknown.
 */
export async function countActiveMenusUsingIngredient(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(menuIngredientItems)
    .innerJoin(
      menus,
      and(eq(menus.organizationId, organizationId), eq(menus.id, menuIngredientItems.menuId)),
    )
    .where(
      and(
        eq(menuIngredientItems.organizationId, organizationId),
        eq(menuIngredientItems.ingredientId, ingredientId),
        isNull(menus.deletedAt),
      ),
    );
  return rows[0]?.value ?? 0;
}

/**
 * Why an ingredient's TYPE (weight / volume / count) can't change: quantities held in
 * its current canonical unit — active recipe lines (g/ml/pcs), active dish lines, or
 * stock movements. Changing the type would silently reinterpret all of them (500 g
 * becoming 500 pieces), so the edit is refused instead.
 */
export type IngredientTypeLock = { recipes: number; menus: number; stock: boolean };

export async function listIngredientTypeLocks(
  db: TenantClient,
  organizationId: string,
  ingredientIds?: string[],
): Promise<Map<string, IngredientTypeLock>> {
  const scoped = (column: AnyPgColumn) =>
    ingredientIds ? inArray(column, ingredientIds) : undefined;
  if (ingredientIds && ingredientIds.length === 0) return new Map();

  const [recipeRows, menuRows, stockRows] = await Promise.all([
    db
      .select({ ingredientId: recipeIngredients.ingredientId, value: countDistinct(recipeIngredients.recipeId) })
      .from(recipeIngredients)
      .innerJoin(recipes, and(eq(recipes.organizationId, organizationId), eq(recipes.id, recipeIngredients.recipeId)))
      .where(and(eq(recipeIngredients.organizationId, organizationId), isNull(recipes.deletedAt), scoped(recipeIngredients.ingredientId)))
      .groupBy(recipeIngredients.ingredientId),
    db
      .select({ ingredientId: menuIngredientItems.ingredientId, value: countDistinct(menuIngredientItems.menuId) })
      .from(menuIngredientItems)
      .innerJoin(menus, and(eq(menus.organizationId, organizationId), eq(menus.id, menuIngredientItems.menuId)))
      .where(and(eq(menuIngredientItems.organizationId, organizationId), isNull(menus.deletedAt), scoped(menuIngredientItems.ingredientId)))
      .groupBy(menuIngredientItems.ingredientId),
    db
      .selectDistinct({ ingredientId: inventoryMovements.ingredientId })
      .from(inventoryMovements)
      .where(and(eq(inventoryMovements.organizationId, organizationId), scoped(inventoryMovements.ingredientId))),
  ]);

  const locks = new Map<string, IngredientTypeLock>();
  const entry = (id: string) => {
    const current = locks.get(id) ?? { recipes: 0, menus: 0, stock: false };
    locks.set(id, current);
    return current;
  };
  for (const r of recipeRows) entry(r.ingredientId).recipes = Number(r.value);
  for (const r of menuRows) entry(r.ingredientId).menus = Number(r.value);
  for (const r of stockRows) entry(r.ingredientId).stock = true;
  return locks;
}
