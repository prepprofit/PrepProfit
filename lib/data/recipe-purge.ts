import type { TenantClient } from '@/lib/db/tenant';
import { countMenusUsingRecipe } from '@/lib/data/menus';
import { countProductionsUsingRecipe } from '@/lib/data/productions';
import { countSalesUsingRecipe } from '@/lib/data/sales';
import { purgeRecipe } from '@/lib/data/recipes';

/**
 * Recipe-purge guard (Sprint 11a, generalizing the Sprint 10 Menus guard). A recipe
 * referenced by any menu line OR any production line is purge-blocked (`ON DELETE
 * restrict` FKs), regardless of the referencing document's own state (D4). This
 * module is the single point that evaluates those blockers BEFORE any side effect, so
 * a blocked manual purge never nulls a referencing transaction.
 *
 * Lives in its own module (not menus.ts/productions.ts) so it can import both
 * counters plus `purgeRecipe` without an import cycle.
 */

export type RecipePurgeBlocker = 'menu' | 'production' | 'sale';

/** The set of reasons a recipe cannot be purged (empty = purgeable). */
export async function recipePurgeBlockers(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
): Promise<Set<RecipePurgeBlocker>> {
  const [menus, productions, sales] = await Promise.all([
    countMenusUsingRecipe(db, organizationId, recipeId),
    countProductionsUsingRecipe(db, organizationId, recipeId),
    countSalesUsingRecipe(db, organizationId, recipeId),
  ]);
  const blockers = new Set<RecipePurgeBlocker>();
  if (menus > 0) blockers.add('menu');
  if (productions > 0) blockers.add('production');
  if (sales > 0) blockers.add('sale');
  return blockers;
}

export type RecipePurgeOutcome = 'ok' | 'in_menu' | 'in_production' | 'in_sale';

/**
 * Manual recipe purge with the menu + production + sale guards. Evaluates blockers
 * FIRST: if any menu/production/sale line references the recipe it returns the blocker
 * code with ZERO side effects (in particular it does NOT null referencing
 * transactions). Otherwise it delegates to {@link purgeRecipe}. Runs in the caller's
 * `withOrg` transaction.
 *
 * Stable priority: Menus first (backwards-compatible with Sprint 10's
 * `RECIPE_IN_MENU`), then Production (Sprint 11a), then Sale (Sprint 12a).
 */
export async function purgeRecipeWithGuards(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
): Promise<RecipePurgeOutcome> {
  const blockers = await recipePurgeBlockers(db, organizationId, recipeId);
  if (blockers.has('menu')) return 'in_menu';
  if (blockers.has('production')) return 'in_production';
  if (blockers.has('sale')) return 'in_sale';
  await purgeRecipe(db, organizationId, recipeId);
  return 'ok';
}
