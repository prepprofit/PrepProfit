/**
 * Pure, dependency-free helpers over a flat `{ id, parentId }` folder list — the
 * shared in-memory tree logic for BOTH recipe and menu folders (server validation
 * in lib/data/recipe-folders.ts / lib/data/menus.ts, and client components: the
 * "Move to…" picker, breadcrumbs, drag-and-drop target checks).
 *
 * Org folder counts are small, so every caller loads the full flat list once and
 * derives children/ancestors/descendants from it — no recursive SQL anywhere.
 */

export type FolderTreeNode = { id: string; name: string; parentId: string | null };

/**
 * Immediate children of `parentId` (null = top level). Preserves `all`'s own
 * order — recipe folders come pre-ordered by manual `sortOrder`, menu folders
 * by name; this helper must not silently override either.
 */
export function folderChildren<T extends FolderTreeNode>(
  all: readonly T[],
  parentId: string | null,
): T[] {
  return all.filter((f) => f.parentId === parentId);
}

/** Ancestor chain from the root down to (but excluding) `id`. Empty if `id` is root, missing, or the chain is broken. */
export function folderAncestors<T extends FolderTreeNode>(all: readonly T[], id: string): T[] {
  const byId = new Map(all.map((f) => [f.id, f]));
  const chain: T[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current?.parentId != null) {
    if (seen.has(current.parentId)) break; // guard against a corrupt/cyclic chain
    seen.add(current.parentId);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    chain.unshift(parent);
    current = parent;
  }
  return chain;
}

/** Full path from the root down to `id` INCLUSIVE — for breadcrumbs. */
export function folderPath<T extends FolderTreeNode>(all: readonly T[], id: string): T[] {
  const self = all.find((f) => f.id === id);
  if (!self) return [];
  return [...folderAncestors(all, id), self];
}

/** "Wibox › Linda" style label for `id`'s ancestors (excludes `id`'s own name). */
export function folderAncestorLabel<T extends FolderTreeNode>(
  all: readonly T[],
  id: string,
  separator = ' › ',
): string {
  return folderAncestors(all, id)
    .map((f) => f.name)
    .join(separator);
}

/** "Wibox › Linda" style label for `id` ITSELF (ancestors + its own name). */
export function folderLabel<T extends FolderTreeNode>(
  all: readonly T[],
  id: string,
  separator = ' › ',
): string {
  return folderPath(all, id)
    .map((f) => f.name)
    .join(separator);
}

/** ids of every descendant of `id` (NOT including `id` itself). */
export function folderDescendantIds<T extends FolderTreeNode>(
  all: readonly T[],
  id: string,
): Set<string> {
  const childrenOf = new Map<string | null, T[]>();
  for (const f of all) {
    const bucket = childrenOf.get(f.parentId);
    if (bucket) bucket.push(f);
    else childrenOf.set(f.parentId, [f]);
  }
  const result = new Set<string>();
  const queue = [...(childrenOf.get(id) ?? [])];
  while (queue.length > 0) {
    const next = queue.pop();
    if (!next || result.has(next.id)) continue;
    result.add(next.id);
    queue.push(...(childrenOf.get(next.id) ?? []));
  }
  return result;
}

export type FolderMoveRejection = 'NOT_FOUND' | 'SELF' | 'DESCENDANT';

/**
 * Validates a proposed reparent. `newParentId` null = "Top level" (always valid
 * unless the folder itself is missing). Returns the rejection reason, or null
 * when the move is valid.
 */
export function validateFolderMove<T extends FolderTreeNode>(
  all: readonly T[],
  id: string,
  newParentId: string | null,
): FolderMoveRejection | null {
  const folder = all.find((f) => f.id === id);
  if (!folder) return 'NOT_FOUND';
  if (newParentId === null) return null;
  if (newParentId === id) return 'SELF';
  const target = all.find((f) => f.id === newParentId);
  if (!target) return 'NOT_FOUND';
  if (folderDescendantIds(all, id).has(newParentId)) return 'DESCENDANT';
  return null;
}

/** Every folder EXCEPT `id` and its descendants — the valid "Move to…" destination set. */
export function validMoveDestinations<T extends FolderTreeNode>(
  all: readonly T[],
  id: string,
): T[] {
  const excluded = folderDescendantIds(all, id);
  excluded.add(id);
  return all.filter((f) => !excluded.has(f.id));
}
