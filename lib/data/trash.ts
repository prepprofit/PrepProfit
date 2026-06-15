import { and, eq, isNotNull, lte, notExists, sql } from 'drizzle-orm';
import { ingredients, recipeIngredients, recipes } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';

/**
 * Permanent deletion of trash that has outlived the retention window. Always
 * org-scoped (RULE #1) — the auto-purge cron calls this once per organization
 * inside `withOrg`, so RLS stays active and no policy carve-out is needed.
 *
 * `cutoff` comes from {@link purgeCutoff} in lib/trash.ts: rows with
 * `deleted_at <= cutoff` are expired.
 */
export type PurgeResult = { recipes: number; ingredients: number };

export async function purgeExpired(
  db: TenantClient,
  organizationId: string,
  cutoff: Date,
): Promise<PurgeResult> {
  // Recipes first: deleting a recipe cascades its lines (composite FK), freeing
  // any ingredient those lines pinned via the `ON DELETE restrict` FK.
  const purgedRecipes = await db
    .delete(recipes)
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        isNotNull(recipes.deletedAt),
        lte(recipes.deletedAt, cutoff),
      ),
    )
    .returning({ id: recipes.id });

  // Then expired ingredients, skipping any still referenced by a (trashed)
  // recipe line — that recipe will purge on its own expiry, freeing it later.
  // The NOT EXISTS avoids the restrict FK violation instead of catching it.
  const purgedIngredients = await db
    .delete(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        isNotNull(ingredients.deletedAt),
        lte(ingredients.deletedAt, cutoff),
        notExists(
          db
            .select({ one: sql`1` })
            .from(recipeIngredients)
            .where(
              and(
                eq(recipeIngredients.organizationId, organizationId),
                eq(recipeIngredients.ingredientId, ingredients.id),
              ),
            ),
        ),
      ),
    )
    .returning({ id: ingredients.id });

  return { recipes: purgedRecipes.length, ingredients: purgedIngredients.length };
}
