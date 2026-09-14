/**
 * Ordering and search for the Recipes library. Pure, so the order is tested without
 * rendering anything.
 *
 * "Recent activity" = the latest of when a recipe was last edited and last opened,
 * falling back to when it was created. Opening is tracked separately from editing
 * (`last_opened_at` vs `updated_at`), so neither pretends to be the other.
 *
 * Search runs across every folder: matches rank by how directly the name answers the
 * query, and recipes that rank equally keep the recent-activity order.
 */

export type RecencyFields = {
  createdAt: Date;
  updatedAt: Date;
  lastOpenedAt: Date | null;
};

function time(value: Date | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const t = value.getTime();
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** The moment that counts for "recent activity". */
export function recentActivityAt(row: RecencyFields): Date {
  const latest = Math.max(time(row.createdAt), time(row.updatedAt), time(row.lastOpenedAt));
  return Number.isFinite(latest) ? new Date(latest) : row.createdAt;
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** Most recent activity first; ties by name, then id so the order never flickers. */
export function compareRecentActivity<T extends { id: string; name: string; recentActivityAt: Date }>(
  a: T,
  b: T,
): number {
  return (
    time(b.recentActivityAt) - time(a.recentActivityAt) ||
    collator.compare(a.name, b.name) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function normalizeRecipeSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const NO_MATCH = Number.POSITIVE_INFINITY;

/**
 * 0 the whole name · 1 the name starts with the query · 2 every query word starts a
 * word of the name · 3 every query word appears somewhere · otherwise no match.
 */
export function recipeSearchRank(name: string, query: string): number {
  const q = normalizeRecipeSearch(query);
  if (q === '') return NO_MATCH;
  const n = normalizeRecipeSearch(name);
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  const words = n.split(' ');
  const terms = q.split(' ');
  if (terms.every((term) => words.some((w) => w.startsWith(term)))) return 2;
  if (terms.every((term) => n.includes(term))) return 3;
  return NO_MATCH;
}

/** Matches across all folders, best match first, recent activity breaking ties. */
export function searchLibrary<T extends { id: string; name: string; recentActivityAt: Date }>(
  rows: readonly T[],
  query: string,
): T[] {
  return rows
    .map((row) => ({ row, rank: recipeSearchRank(row.name, query) }))
    .filter((r) => r.rank !== NO_MATCH)
    .sort((a, b) => a.rank - b.rank || compareRecentActivity(a.row, b.row))
    .map((r) => r.row);
}
