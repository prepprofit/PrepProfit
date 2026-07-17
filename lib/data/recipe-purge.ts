import { and, eq } from 'drizzle-orm';
import { recipeMedia } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { countMenusUsingRecipe } from '@/lib/data/menus';
import { countProductionsUsingRecipe } from '@/lib/data/productions';
import { countSalesUsingRecipe } from '@/lib/data/sales';
import { countAnyParentsUsingComponent } from '@/lib/data/recipe-components';
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

export type RecipePurgeBlocker = 'menu' | 'production' | 'sale' | 'component';

/** The set of reasons a recipe cannot be purged (empty = purgeable). */
export async function recipePurgeBlockers(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
): Promise<Set<RecipePurgeBlocker>> {
  const [menus, productions, sales, parents] = await Promise.all([
    countMenusUsingRecipe(db, organizationId, recipeId),
    countProductionsUsingRecipe(db, organizationId, recipeId),
    countSalesUsingRecipe(db, organizationId, recipeId),
    // ANY surviving component row (incl. under trashed parents) blocks — the
    // `recipe_components_component_fk` restrict FK is the DB backstop.
    countAnyParentsUsingComponent(db, organizationId, recipeId),
  ]);
  const blockers = new Set<RecipePurgeBlocker>();
  if (menus > 0) blockers.add('menu');
  if (productions > 0) blockers.add('production');
  if (sales > 0) blockers.add('sale');
  if (parents > 0) blockers.add('component');
  return blockers;
}

export type RecipePurgeOutcome =
  | 'ok'
  | 'in_menu'
  | 'in_production'
  | 'in_sale'
  | 'in_component';

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
  /**
   * When provided, receives the storage keys of the recipe's media objects
   * (Fase 3 §6.4) — their DB rows cascade away with the recipe, so the caller
   * must remove the bucket objects AFTER the transaction commits (idempotent,
   * best-effort, never inside the tx).
   */
  outMediaStorageKeys?: string[],
): Promise<RecipePurgeOutcome> {
  const blockers = await recipePurgeBlockers(db, organizationId, recipeId);
  if (blockers.has('menu')) return 'in_menu';
  if (blockers.has('production')) return 'in_production';
  if (blockers.has('sale')) return 'in_sale';
  if (blockers.has('component')) return 'in_component';
  if (outMediaStorageKeys) {
    const rows = await db
      .select({ storageKey: recipeMedia.storageKey })
      .from(recipeMedia)
      .where(
        and(
          eq(recipeMedia.organizationId, organizationId),
          eq(recipeMedia.recipeId, recipeId),
        ),
      );
    outMediaStorageKeys.push(...rows.map((r) => r.storageKey));
  }
  await purgeRecipe(db, organizationId, recipeId);
  return 'ok';
}
