import { and, count, eq, isNull, max } from 'drizzle-orm';
import { recipeFolders, recipes } from '@/lib/db/schema';
import type { RecipeFolder } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';

/**
 * Access to `recipe_folders` is ALWAYS scoped by `organizationId` (RULE #1) —
 * derived on the server, never trusted from the client; RLS is the second layer.
 *
 * Folders are a flat, per-org namespace and are HARD-deleted (no soft-delete):
 * {@link deleteFolder} reassigns its recipes to "No folder" and drops the row in
 * the caller's transaction. Reads of recipes filtered by folder still honour the
 * soft-delete (`deleted_at IS NULL`) — see {@link listFoldersWithCounts} and
 * `listRecipes` in lib/data/recipes.ts.
 */

/** A folder plus how many ACTIVE recipes it holds (trashed ones never count). */
export type FolderWithCount = {
  id: string;
  name: string;
  sortOrder: number;
  recipeCount: number;
};

/** Everything the folder rail needs in one shape: folders + the two pseudo-views. */
export type FolderListing = {
  folders: FolderWithCount[];
  /** Active recipes with no folder ("No folder"). */
  uncategorizedCount: number;
  /** All active recipes in the org (the "All recipes" view). */
  totalCount: number;
};

export async function listFolders(
  db: TenantClient,
  organizationId: string,
): Promise<RecipeFolder[]> {
  return db
    .select()
    .from(recipeFolders)
    .where(eq(recipeFolders.organizationId, organizationId))
    .orderBy(recipeFolders.sortOrder, recipeFolders.name);
}

/**
 * Folders with per-folder active-recipe counts, plus the uncategorized and total
 * counts for the "No folder" / "All recipes" views. Two org-scoped queries (the
 * folders, then a grouped count over active recipes) — no N+1.
 */
export async function listFoldersWithCounts(
  db: TenantClient,
  organizationId: string,
): Promise<FolderListing> {
  const folders = await listFolders(db, organizationId);

  const countRows = await db
    .select({ folderId: recipes.folderId, value: count() })
    .from(recipes)
    .where(
      and(eq(recipes.organizationId, organizationId), isNull(recipes.deletedAt)),
    )
    .groupBy(recipes.folderId);

  const byFolder = new Map<string, number>();
  let uncategorizedCount = 0;
  let totalCount = 0;
  for (const row of countRows) {
    totalCount += row.value;
    if (row.folderId === null) uncategorizedCount += row.value;
    else byFolder.set(row.folderId, row.value);
  }

  return {
    folders: folders.map((f) => ({
      id: f.id,
      name: f.name,
      sortOrder: f.sortOrder,
      recipeCount: byFolder.get(f.id) ?? 0,
    })),
    uncategorizedCount,
    totalCount,
  };
}

/**
 * Creates a folder at the end of the rail. `sort_order` = (current max) + 1 so
 * folders keep distinct, append-only positions even after deletions — which
 * keeps {@link reorderFolder}'s neighbour swap unambiguous. A duplicate name
 * raises a unique violation the action surfaces.
 */
export async function createFolder(
  db: TenantClient,
  organizationId: string,
  name: string,
): Promise<RecipeFolder> {
  const [maxRow] = await db
    .select({ value: max(recipeFolders.sortOrder) })
    .from(recipeFolders)
    .where(eq(recipeFolders.organizationId, organizationId));
  const nextOrder = maxRow?.value == null ? 0 : maxRow.value + 1;

  const [row] = await db
    .insert(recipeFolders)
    .values({ organizationId, name, sortOrder: nextOrder })
    .returning();
  if (!row) throw new Error('Failed to create folder.');
  return row;
}

/** Renames a folder. Returns null if it does not exist; unique violation bubbles up. */
export async function renameFolder(
  db: TenantClient,
  organizationId: string,
  id: string,
  name: string,
): Promise<RecipeFolder | null> {
  const [row] = await db
    .update(recipeFolders)
    .set({ name })
    .where(
      and(
        eq(recipeFolders.organizationId, organizationId),
        eq(recipeFolders.id, id),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Moves a folder one slot up or down by swapping its `sort_order` with the
 * adjacent folder's. Returns false at the ends (nothing to swap) or if the
 * folder is gone. Both updates run in the caller's `withOrg` transaction.
 */
export async function reorderFolder(
  db: TenantClient,
  organizationId: string,
  id: string,
  direction: 'up' | 'down',
): Promise<boolean> {
  const ordered = await db
    .select({ id: recipeFolders.id, sortOrder: recipeFolders.sortOrder })
    .from(recipeFolders)
    .where(eq(recipeFolders.organizationId, organizationId))
    .orderBy(recipeFolders.sortOrder, recipeFolders.name);

  const index = ordered.findIndex((f) => f.id === id);
  if (index === -1) return false;
  const swapIndex = direction === 'up' ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= ordered.length) return false;

  const current = ordered[index]!;
  const neighbour = ordered[swapIndex]!;

  await db
    .update(recipeFolders)
    .set({ sortOrder: neighbour.sortOrder })
    .where(
      and(
        eq(recipeFolders.organizationId, organizationId),
        eq(recipeFolders.id, current.id),
      ),
    );
  await db
    .update(recipeFolders)
    .set({ sortOrder: current.sortOrder })
    .where(
      and(
        eq(recipeFolders.organizationId, organizationId),
        eq(recipeFolders.id, neighbour.id),
      ),
    );
  return true;
}

/**
 * Hard-deletes a folder and re-files its recipes to "No folder". Reassigns ALL
 * matching recipes (active AND trashed) so the `ON DELETE restrict` FK never
 * blocks the delete, then drops the folder. Atomic: the caller wraps this in one
 * `withOrg` transaction. Returns false if the folder did not exist.
 */
export async function deleteFolder(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<boolean> {
  await db
    .update(recipes)
    .set({ folderId: null })
    .where(
      and(eq(recipes.organizationId, organizationId), eq(recipes.folderId, id)),
    );

  const deleted = await db
    .delete(recipeFolders)
    .where(
      and(
        eq(recipeFolders.organizationId, organizationId),
        eq(recipeFolders.id, id),
      ),
    )
    .returning({ id: recipeFolders.id });
  return deleted.length > 0;
}
