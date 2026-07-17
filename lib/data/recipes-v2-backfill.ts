import { and, eq, isNull, isNotNull, notExists, sql } from 'drizzle-orm';
import {
  recipes,
  recipeFolders,
  recipeBooks,
  recipeBookEntries,
  recipePortionOptions,
} from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';

/**
 * Recipes 2.0 backfill — the per-ORG transform (Meez-parity plan, Release A;
 * scripts/backfill-recipes-v2.ts fans this out over Clerk orgs inside
 * `withOrg`, exactly like the Sprint 7 supplier backfill). Kept here so it is
 * unit-testable and the script stays a thin RLS-safe driver.
 *
 * IDEMPOTENT — safe to re-run any number of times:
 * 1. each recipe_folder becomes a recipe_book (keyed by the shared
 *    unique (org, name); existing books are kept, never duplicated);
 * 2. each active recipe's `folder_id` becomes a book membership (keyed by
 *    unique (org, book, recipe));
 * 3. recipes without a chef-facing yield get `yield_quantity = yield_portions`,
 *    `yield_unit = 'serving'` (only where yield_quantity IS NULL);
 * 4. recipes without ANY portion option get a "Default serving" option
 *    (quantity 1 serving, is_default, carrying the legacy selling_price_cents
 *    — which may be NULL: "no price yet" stays honest).
 *
 * Nothing legacy is modified or removed: `folder_id`/`recipe_folders` and
 * `selling_price_cents` remain the live source for the old editor until
 * Release C (dual-read/dual-write) retires them.
 */
export type RecipesV2BackfillStats = {
  booksCreated: number;
  membershipsCreated: number;
  yieldsBackfilled: number;
  portionOptionsCreated: number;
};

export async function backfillRecipesV2ForOrg(
  db: TenantClient,
  organizationId: string,
): Promise<RecipesV2BackfillStats> {
  // 1. Folders → books (name is the idempotency key; icon/sort carried over).
  const folders = await db
    .select()
    .from(recipeFolders)
    .where(eq(recipeFolders.organizationId, organizationId));

  let booksCreated = 0;
  for (const folder of folders) {
    const inserted = await db
      .insert(recipeBooks)
      .values({
        organizationId,
        name: folder.name,
        icon: folder.icon,
        sortOrder: folder.sortOrder,
      })
      .onConflictDoNothing({
        target: [recipeBooks.organizationId, recipeBooks.name],
      })
      .returning({ id: recipeBooks.id });
    booksCreated += inserted.length;
  }

  // 2. folder memberships → book entries. Resolve book by the folder's name
  // (the shared unique key). Trashed recipes keep their membership too — the
  // restore flow should bring a recipe back into its book.
  const filedRecipes = await db
    .select({
      recipeId: recipes.id,
      folderName: recipeFolders.name,
    })
    .from(recipes)
    .innerJoin(
      recipeFolders,
      and(
        eq(recipeFolders.organizationId, recipes.organizationId),
        eq(recipeFolders.id, recipes.folderId),
      ),
    )
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        isNotNull(recipes.folderId),
      ),
    );

  let membershipsCreated = 0;
  for (const r of filedRecipes) {
    const [book] = await db
      .select({ id: recipeBooks.id })
      .from(recipeBooks)
      .where(
        and(
          eq(recipeBooks.organizationId, organizationId),
          eq(recipeBooks.name, r.folderName),
        ),
      )
      .limit(1);
    if (!book) continue; // folder created after step 1 — next run picks it up
    const inserted = await db
      .insert(recipeBookEntries)
      .values({
        organizationId,
        recipeBookId: book.id,
        recipeId: r.recipeId,
      })
      .onConflictDoNothing({
        target: [
          recipeBookEntries.organizationId,
          recipeBookEntries.recipeBookId,
          recipeBookEntries.recipeId,
        ],
      })
      .returning({ id: recipeBookEntries.id });
    membershipsCreated += inserted.length;
  }

  // 3. Chef-facing yield from the legacy portions count (only where unset —
  // a hand-edited yield is never overwritten by a re-run).
  const yieldRows = await db
    .update(recipes)
    .set({
      yieldQuantity: sql`${recipes.yieldPortions}`,
      yieldUnit: 'serving',
    })
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        isNull(recipes.yieldQuantity),
      ),
    )
    .returning({ id: recipes.id });
  const yieldsBackfilled = yieldRows.length;

  // 4. "Default serving" portion option for recipes that have none yet.
  const withoutOptions = await db
    .select({
      id: recipes.id,
      sellingPriceCents: recipes.sellingPriceCents,
    })
    .from(recipes)
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        notExists(
          db
            .select({ one: sql`1` })
            .from(recipePortionOptions)
            .where(
              and(
                eq(
                  recipePortionOptions.organizationId,
                  recipes.organizationId,
                ),
                eq(recipePortionOptions.recipeId, recipes.id),
              ),
            ),
        ),
      ),
    );

  let portionOptionsCreated = 0;
  for (const r of withoutOptions) {
    const inserted = await db
      .insert(recipePortionOptions)
      .values({
        organizationId,
        recipeId: r.id,
        name: 'Default serving',
        quantity: 1,
        unit: 'serving',
        sellingPriceCents: r.sellingPriceCents,
        isDefault: true,
      })
      // The partial one-default-per-recipe unique index absorbs a concurrent
      // duplicate; anything else should surface.
      .onConflictDoNothing()
      .returning({ id: recipePortionOptions.id });
    portionOptionsCreated += inserted.length;
  }

  return {
    booksCreated,
    membershipsCreated,
    yieldsBackfilled,
    portionOptionsCreated,
  };
}
