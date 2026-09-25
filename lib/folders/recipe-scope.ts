/**
 * "Everything inside this folder" — the read-side aggregation that makes folder
 * browsing RECURSIVE: opening a folder shows its own recipes AND every recipe
 * filed in any of its subfolders, at any depth, and a folder's count is the
 * inclusive total.
 *
 * Purely derived: no recipe's `folder_id` is ever rewritten to achieve this, and
 * there is no recursive SQL — callers already load the flat folder list once
 * (see lib/folders/tree.ts's contract) and the scope is derived in memory from
 * it. Shared by /recipes and /kitchen-scale so the two can never disagree.
 *
 * Every input list is expected to be ALREADY org-scoped and already filtered by
 * `deleted_at IS NULL` (RULE #1 + soft-delete stay upstream of this module).
 */

import { folderDescendantIds, type FolderTreeNode } from './tree';

/** Which recipes a page is browsing: everything, the unfiled ones, or one folder's subtree. */
export type FolderScope =
  | { kind: 'all' }
  | { kind: 'unfiled' }
  | { kind: 'folder'; folderId: string };

/** `folderId` itself plus every descendant of it — the folder ids a subtree covers. */
export function folderScopeIds<T extends FolderTreeNode>(
  all: readonly T[],
  folderId: string,
): Set<string> {
  const ids = folderDescendantIds(all, folderId);
  ids.add(folderId);
  return ids;
}

/**
 * The recipes visible in `scope`, each EXACTLY ONCE (a recipe lives in a single
 * folder, and the scope is a set of folder ids, so nesting can never duplicate
 * it). Input order is preserved — callers pass recipes already in
 * recent-activity order and rely on that being the default.
 */
export function recipesInFolderScope<
  F extends FolderTreeNode,
  R extends { folderId: string | null },
>(folders: readonly F[], recipes: readonly R[], scope: FolderScope): R[] {
  if (scope.kind === 'all') return [...recipes];
  if (scope.kind === 'unfiled') return recipes.filter((r) => r.folderId === null);
  const ids = folderScopeIds(folders, scope.folderId);
  return recipes.filter((r) => r.folderId !== null && ids.has(r.folderId));
}

/**
 * Turns DIRECT per-folder counts into INCLUSIVE ones (own recipes + every
 * descendant folder's). Walks each folder's ancestor chain once instead of
 * re-deriving descendants per folder, so a recipe is added to its folder and to
 * each of that folder's ancestors exactly once. A corrupt/cyclic chain is
 * guarded the same way lib/folders/tree.ts guards it.
 */
export function rollUpFolderCounts<T extends FolderTreeNode>(
  folders: readonly T[],
  directCounts: ReadonlyMap<string, number>,
): Map<string, number> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const totals = new Map<string, number>();
  for (const folder of folders) totals.set(folder.id, 0);

  for (const folder of folders) {
    const direct = directCounts.get(folder.id) ?? 0;
    if (direct === 0) continue;
    const seen = new Set<string>();
    let current: T | undefined = folder;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      totals.set(current.id, (totals.get(current.id) ?? 0) + direct);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
  }
  return totals;
}
