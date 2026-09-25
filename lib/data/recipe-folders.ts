import { and, asc, count, eq, isNull, max } from 'drizzle-orm';
import { recipeFolders, recipes } from '@/lib/db/schema';
import type { RecipeFolder } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { validateFolderMove, type FolderMoveRejection } from '@/lib/folders/tree';
import { rollUpFolderCounts } from '@/lib/folders/recipe-scope';

/**
 * Access to `recipe_folders` is ALWAYS scoped by `organizationId` (RULE #1) —
 * derived on the server, never trusted from the client; RLS is the second layer.
 *
 * Folders form a per-org tree (`parentId`, NULL = top level) and are
 * HARD-deleted (no soft-delete): {@link deleteFolder} reassigns its DIRECT
 * recipes to "No folder" and drops the row in the caller's transaction, but is
 * blocked while the folder still has subfolders (see {@link deleteFolder}).
 * Reads of recipes filtered by folder still honour the soft-delete
 * (`deleted_at IS NULL`) — see {@link listFoldersWithCounts} and `listRecipes`
 * in lib/data/recipes.ts.
 */

/**
 * A folder plus how many ACTIVE recipes it holds. `recipeCount` is INCLUSIVE —
 * its own recipes plus every descendant folder's, at any depth — because opening
 * a folder browses its whole subtree (lib/folders/recipe-scope.ts). Trashed
 * recipes never count on either figure.
 */
export type FolderWithCount = {
  id: string;
  name: string;
  icon: string | null;
  sortOrder: number;
  parentId: string | null;
  /** Own recipes + every descendant folder's — what the UI shows. */
  recipeCount: number;
  /** Recipes filed in THIS folder only — kept for callers that need the split. */
  directRecipeCount: number;
};

/** Everything the folder rail needs in one shape: the FULL org-wide flat folder list + the two pseudo-views. */
export type FolderListing = {
  /** Every folder in the org, any level — callers derive children/ancestors via lib/folders/tree.ts. */
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
 * Folders with per-folder INCLUSIVE active-recipe counts (own + every
 * descendant's), plus the uncategorized and total counts for the "No folder" /
 * "All recipes" views. Still two org-scoped queries (the folders, then a grouped
 * DIRECT count over active recipes) — no N+1 and no recursive SQL: the subtree
 * roll-up happens in memory over the already-loaded flat list
 * (lib/folders/recipe-scope.ts). Returns the FULL flat org tree; callers use
 * lib/folders/tree.ts to derive a single level's children, an ancestor
 * breadcrumb, or the valid move targets.
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

  const inclusive = rollUpFolderCounts(folders, byFolder);

  return {
    folders: folders.map((f) => ({
      id: f.id,
      name: f.name,
      icon: f.icon,
      sortOrder: f.sortOrder,
      parentId: f.parentId,
      recipeCount: inclusive.get(f.id) ?? 0,
      directRecipeCount: byFolder.get(f.id) ?? 0,
    })),
    uncategorizedCount,
    totalCount,
  };
}

/**
 * Creates a folder at the end of its SIBLING rail (folders sharing the same
 * `parentId`). `sort_order` = (current max among siblings) + 1 so siblings keep
 * distinct, append-only positions even after deletions — which keeps
 * {@link reorderFolder}'s neighbour swap unambiguous. A duplicate name (within
 * the same parent) raises a unique violation the action surfaces.
 */
export async function createFolder(
  db: TenantClient,
  organizationId: string,
  name: string,
  icon: string | null = null,
  parentId: string | null = null,
): Promise<RecipeFolder> {
  const [maxRow] = await db
    .select({ value: max(recipeFolders.sortOrder) })
    .from(recipeFolders)
    .where(
      and(
        eq(recipeFolders.organizationId, organizationId),
        parentId === null ? isNull(recipeFolders.parentId) : eq(recipeFolders.parentId, parentId),
      ),
    );
  const nextOrder = maxRow?.value == null ? 0 : maxRow.value + 1;

  const [row] = await db
    .insert(recipeFolders)
    .values({ organizationId, name, icon, parentId, sortOrder: nextOrder })
    .returning();
  if (!row) throw new Error('Failed to create folder.');
  return row;
}

/**
 * Updates a folder's name and icon. Returns null if it does not exist; a unique
 * violation (duplicate name within the same parent) bubbles up to the action.
 */
export async function updateFolder(
  db: TenantClient,
  organizationId: string,
  id: string,
  name: string,
  icon: string | null = null,
): Promise<RecipeFolder | null> {
  const [row] = await db
    .update(recipeFolders)
    .set({ name, icon })
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
 * Moves a folder one slot up or down among its SIBLINGS (folders sharing the
 * same `parentId`) by swapping `sort_order` with the adjacent sibling's.
 * Returns false at the ends (nothing to swap) or if the folder is gone. Both
 * updates run in the caller's `withOrg` transaction.
 */
export async function reorderFolder(
  db: TenantClient,
  organizationId: string,
  id: string,
  direction: 'up' | 'down',
): Promise<boolean> {
  const self = await db
    .select({ parentId: recipeFolders.parentId })
    .from(recipeFolders)
    .where(and(eq(recipeFolders.organizationId, organizationId), eq(recipeFolders.id, id)))
    .limit(1);
  const parentId = self[0]?.parentId;
  if (self.length === 0) return false;

  const ordered = await db
    .select({ id: recipeFolders.id, sortOrder: recipeFolders.sortOrder })
    .from(recipeFolders)
    .where(
      and(
        eq(recipeFolders.organizationId, organizationId),
        parentId == null ? isNull(recipeFolders.parentId) : eq(recipeFolders.parentId, parentId),
      ),
    )
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

export type MoveFolderResult =
  | { ok: true; previousParentId: string | null }
  | { ok: false; reason: FolderMoveRejection };

/**
 * Reparents a folder. Locks every folder row of the org FOR UPDATE (id order,
 * deadlock-free — mirrors {@link import('./recipe-components').lockRecipeComponentEndpoints})
 * so two concurrent moves in the same org serialize instead of racing into a
 * cycle. Rejects a self-move or a move into one of the folder's own
 * descendants (lib/folders/tree.ts, checked against the just-locked snapshot).
 * A same-name collision at the destination surfaces as the DB's existing
 * partial-unique-index violation, same as create/rename.
 */
export async function moveFolder(
  db: TenantClient,
  organizationId: string,
  id: string,
  newParentId: string | null,
): Promise<MoveFolderResult> {
  const rows = await db
    .select({ id: recipeFolders.id, name: recipeFolders.name, parentId: recipeFolders.parentId })
    .from(recipeFolders)
    .where(eq(recipeFolders.organizationId, organizationId))
    .orderBy(asc(recipeFolders.id))
    .for('update');

  const rejection = validateFolderMove(rows, id, newParentId);
  if (rejection) return { ok: false, reason: rejection };

  const previousParentId = rows.find((f) => f.id === id)!.parentId;
  await db
    .update(recipeFolders)
    .set({ parentId: newParentId })
    .where(and(eq(recipeFolders.organizationId, organizationId), eq(recipeFolders.id, id)));

  return { ok: true, previousParentId };
}

export type DeleteFolderResult = { deleted: boolean; blockedBySubfolders: boolean };

/**
 * Hard-deletes a folder and re-files its DIRECT recipes to "No folder".
 * Reassigns ALL matching recipes (active AND trashed) so the `ON DELETE
 * restrict` FK never blocks the delete, then drops the folder — atomic: the
 * caller wraps this in one `withOrg` transaction. Blocked (no write happens)
 * while the folder still has subfolders — never silently drops a nested
 * subtree; the caller must move or delete them first.
 */
export async function deleteFolder(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<DeleteFolderResult> {
  const [child] = await db
    .select({ id: recipeFolders.id })
    .from(recipeFolders)
    .where(and(eq(recipeFolders.organizationId, organizationId), eq(recipeFolders.parentId, id)))
    .limit(1);
  if (child) return { deleted: false, blockedBySubfolders: true };

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
  return { deleted: deleted.length > 0, blockedBySubfolders: false };
}
