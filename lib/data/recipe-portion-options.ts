import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  recipes,
  recipePortionOptions,
  type RecipePortionOption,
} from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { writeAuditEvent, type AuditActor } from '@/lib/data/audit';

/**
 * Portion options data layer (Recipes 2.0 Fase 5, plan §6.8). FINANCIAL data
 * (selling price / target food cost) → every mutation is manager-only at the
 * action layer and audited HERE, inside the caller's `withOrg` transaction
 * (atomic with the write, like the other financial mutations). Audit metadata
 * carries ids/flags only — never prices.
 *
 * Invariants, on top of the DB constraints (partial uniques for one default /
 * one nutrition-serving, qty > 0, price ≥ 0, target 1..10000 bps):
 * - mutations lock the ACTIVE recipe row FOR UPDATE first, serializing with
 *   concurrent portion mutations and recipe trash;
 * - `setDefault`/`setNutritionServing` clear the previous holder in the same
 *   transaction (the partial unique is the backstop, not the mechanism);
 * - the LAST portion option of a recipe can be deleted, but a default flag can
 *   only move, never be dropped by an update (dual-read consumers resolve the
 *   default option's price).
 */

const MAX_PORTION_OPTIONS_PER_RECIPE = 50;

async function lockActiveRecipe(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        eq(recipes.id, recipeId),
        isNull(recipes.deletedAt),
      ),
    )
    .for('update')
    .limit(1);
  return rows.length > 0;
}

export async function listPortionOptions(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
): Promise<RecipePortionOption[]> {
  return db
    .select()
    .from(recipePortionOptions)
    .where(
      and(
        eq(recipePortionOptions.organizationId, organizationId),
        eq(recipePortionOptions.recipeId, recipeId),
      ),
    )
    .orderBy(asc(recipePortionOptions.sortOrder), asc(recipePortionOptions.createdAt));
}

/**
 * AUTHORITATIVE per-recipe selling price: the DEFAULT portion option's price
 * (Fase 5, §6.8). The dual-read fallback to the legacy `recipes.
 * selling_price_cents` column was RETIRED in Fase 7 Slice 6b, after the prod
 * parity verify (`npm run verify:recipes-v2`) confirmed every recipe has a
 * priced/priceable default option and none was left behind the legacy column.
 * Consumers now use `map.get(recipeId) ?? null` — an ABSENT entry means
 * "unpriced", NEVER a fall back to the legacy column. A price of 0 (free) is a
 * real price and is included; only a NULL option price is omitted. Every write
 * path keeps the option in sync via `syncLegacyPriceToDefaultOption`.
 */
export async function loadDefaultPortionPrices(
  db: TenantClient,
  organizationId: string,
  recipeIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (recipeIds.length === 0) return map;
  const rows = await db
    .select({
      recipeId: recipePortionOptions.recipeId,
      sellingPriceCents: recipePortionOptions.sellingPriceCents,
    })
    .from(recipePortionOptions)
    .where(
      and(
        eq(recipePortionOptions.organizationId, organizationId),
        inArray(recipePortionOptions.recipeId, [...new Set(recipeIds)]),
        eq(recipePortionOptions.isDefault, true),
      ),
    );
  for (const row of rows) {
    if (row.sellingPriceCents != null) map.set(row.recipeId, row.sellingPriceCents);
  }
  return map;
}

/**
 * LEGACY-PRICE WRITE-THROUGH (Fase 7 Slice 5): mirrors a legacy
 * `recipes.selling_price_cents` write onto the recipe's DEFAULT portion
 * option, so the option is always at least as fresh as the legacy column and
 * the Slice 6 fallback removal cannot lose a price. Called by the recipes data
 * layer inside its own `withOrg` transaction:
 * - default option exists → update its price (the legacy editor's save is an
 *   explicit price statement, including clearing it to NULL);
 * - none exists → create the backfill-shaped "Default serving" (1 serving,
 *   is_default) carrying the price.
 * NOT audited: the surrounding recipe save is the user action; this is a
 * derived mirror, and the partial one-default unique absorbs a concurrent
 * duplicate creation.
 */
export async function syncLegacyPriceToDefaultOption(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
  sellingPriceCents: number | null,
): Promise<void> {
  const updated = await db
    .update(recipePortionOptions)
    .set({ sellingPriceCents })
    .where(
      and(
        eq(recipePortionOptions.organizationId, organizationId),
        eq(recipePortionOptions.recipeId, recipeId),
        eq(recipePortionOptions.isDefault, true),
      ),
    )
    .returning({ id: recipePortionOptions.id });
  if (updated.length > 0) return;

  await db
    .insert(recipePortionOptions)
    .values({
      organizationId,
      recipeId,
      name: 'Default serving',
      quantity: 1,
      unit: 'serving',
      sellingPriceCents,
      isDefault: true,
    })
    .onConflictDoNothing();
}

export type SavePortionOptionInput = {
  name: string;
  quantity: number;
  unit: string;
  sellingPriceCents: number | null;
  targetFoodCostBps: number | null;
  sortOrder?: number;
};

export type PortionOptionResult =
  | { status: 'done'; option: RecipePortionOption }
  | { status: 'not_found' }
  | { status: 'limit_reached' };

export async function createPortionOption(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
  input: SavePortionOptionInput,
  actor: AuditActor,
): Promise<PortionOptionResult> {
  if (!(await lockActiveRecipe(db, organizationId, recipeId))) {
    return { status: 'not_found' };
  }
  const existing = await listPortionOptions(db, organizationId, recipeId);
  if (existing.length >= MAX_PORTION_OPTIONS_PER_RECIPE) {
    return { status: 'limit_reached' };
  }
  const [row] = await db
    .insert(recipePortionOptions)
    .values({
      organizationId,
      recipeId,
      name: input.name,
      quantity: input.quantity,
      unit: input.unit,
      sellingPriceCents: input.sellingPriceCents,
      targetFoodCostBps: input.targetFoodCostBps,
      sortOrder: input.sortOrder ?? existing.length,
      // The first option of a recipe becomes the default automatically — the
      // dual-read price resolution always has a row to land on.
      isDefault: existing.length === 0,
    })
    .returning();
  await writeAuditEvent(db, organizationId, actor, {
    action: 'recipe.portionOptionCreate',
    entityType: 'recipe_portion_option',
    entityId: row!.id,
    metadata: {
      recipeId,
      isDefault: row!.isDefault,
      hasPrice: row!.sellingPriceCents != null,
      hasTarget: row!.targetFoodCostBps != null,
    },
  });
  return { status: 'done', option: row! };
}

export async function updatePortionOption(
  db: TenantClient,
  organizationId: string,
  optionId: string,
  input: SavePortionOptionInput,
  actor: AuditActor,
): Promise<PortionOptionResult> {
  const current = await getOwnedOption(db, organizationId, optionId);
  if (!current) return { status: 'not_found' };
  if (!(await lockActiveRecipe(db, organizationId, current.recipeId))) {
    return { status: 'not_found' };
  }
  const [row] = await db
    .update(recipePortionOptions)
    .set({
      name: input.name,
      quantity: input.quantity,
      unit: input.unit,
      sellingPriceCents: input.sellingPriceCents,
      targetFoodCostBps: input.targetFoodCostBps,
      sortOrder: input.sortOrder ?? current.sortOrder,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(recipePortionOptions.organizationId, organizationId),
        eq(recipePortionOptions.id, optionId),
      ),
    )
    .returning();
  if (!row) return { status: 'not_found' };
  await writeAuditEvent(db, organizationId, actor, {
    action: 'recipe.portionOptionUpdate',
    entityType: 'recipe_portion_option',
    entityId: row.id,
    metadata: {
      recipeId: row.recipeId,
      hasPrice: row.sellingPriceCents != null,
      hasTarget: row.targetFoodCostBps != null,
    },
  });
  return { status: 'done', option: row };
}

export async function deletePortionOption(
  db: TenantClient,
  organizationId: string,
  optionId: string,
  actor: AuditActor,
): Promise<'done' | 'not_found'> {
  const current = await getOwnedOption(db, organizationId, optionId);
  if (!current) return 'not_found';
  if (!(await lockActiveRecipe(db, organizationId, current.recipeId))) {
    return 'not_found';
  }
  const deleted = await db
    .delete(recipePortionOptions)
    .where(
      and(
        eq(recipePortionOptions.organizationId, organizationId),
        eq(recipePortionOptions.id, optionId),
      ),
    )
    .returning({ id: recipePortionOptions.id, isDefault: recipePortionOptions.isDefault });
  if (deleted.length === 0) return 'not_found';

  // If the default was deleted, promote the first remaining option so the
  // dual-read price resolution never dangles (no-op when none remain).
  if (deleted[0]!.isDefault) {
    const remaining = await listPortionOptions(db, organizationId, current.recipeId);
    const next = remaining[0];
    if (next) {
      await db
        .update(recipePortionOptions)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(
          and(
            eq(recipePortionOptions.organizationId, organizationId),
            eq(recipePortionOptions.id, next.id),
          ),
        );
    }
  }
  await writeAuditEvent(db, organizationId, actor, {
    action: 'recipe.portionOptionDelete',
    entityType: 'recipe_portion_option',
    entityId: optionId,
    metadata: { recipeId: current.recipeId, wasDefault: deleted[0]!.isDefault },
  });
  return 'done';
}

/**
 * Moves a per-recipe exclusive flag (`is_default` / `is_nutrition_serving`)
 * onto one option: clears the current holder, then sets the target — both in
 * the caller's transaction, under the recipe lock.
 */
async function moveExclusiveFlag(
  db: TenantClient,
  organizationId: string,
  optionId: string,
  flag: 'isDefault' | 'isNutritionServing',
  actor: AuditActor,
): Promise<PortionOptionResult> {
  const current = await getOwnedOption(db, organizationId, optionId);
  if (!current) return { status: 'not_found' };
  if (!(await lockActiveRecipe(db, organizationId, current.recipeId))) {
    return { status: 'not_found' };
  }
  const column =
    flag === 'isDefault'
      ? recipePortionOptions.isDefault
      : recipePortionOptions.isNutritionServing;
  await db
    .update(recipePortionOptions)
    .set({ [flag]: false, updatedAt: new Date() })
    .where(
      and(
        eq(recipePortionOptions.organizationId, organizationId),
        eq(recipePortionOptions.recipeId, current.recipeId),
        eq(column, true),
        ne(recipePortionOptions.id, optionId),
      ),
    );
  const [row] = await db
    .update(recipePortionOptions)
    .set({ [flag]: true, updatedAt: new Date() })
    .where(
      and(
        eq(recipePortionOptions.organizationId, organizationId),
        eq(recipePortionOptions.id, optionId),
      ),
    )
    .returning();
  if (!row) return { status: 'not_found' };
  await writeAuditEvent(db, organizationId, actor, {
    action:
      flag === 'isDefault'
        ? 'recipe.portionOptionSetDefault'
        : 'recipe.portionOptionSetNutritionServing',
    entityType: 'recipe_portion_option',
    entityId: row.id,
    metadata: { recipeId: row.recipeId },
  });
  return { status: 'done', option: row };
}

export function setDefaultPortionOption(
  db: TenantClient,
  organizationId: string,
  optionId: string,
  actor: AuditActor,
): Promise<PortionOptionResult> {
  return moveExclusiveFlag(db, organizationId, optionId, 'isDefault', actor);
}

export function setNutritionServingPortionOption(
  db: TenantClient,
  organizationId: string,
  optionId: string,
  actor: AuditActor,
): Promise<PortionOptionResult> {
  return moveExclusiveFlag(db, organizationId, optionId, 'isNutritionServing', actor);
}

async function getOwnedOption(
  db: TenantClient,
  organizationId: string,
  optionId: string,
): Promise<RecipePortionOption | null> {
  const [row] = await db
    .select()
    .from(recipePortionOptions)
    .where(
      and(
        eq(recipePortionOptions.organizationId, organizationId),
        eq(recipePortionOptions.id, optionId),
      ),
    )
    .limit(1);
  return row ?? null;
}
