import type { CatalogEntry } from './schema';

/**
 * Pure search over the seed ingredient catalogue. Diacritic-insensitive and
 * case-insensitive so "acucar" finds "Açúcar"-style names when PT data lands;
 * ranks whole-name prefix > word prefix > substring, alias matches after name
 * matches of the same rank, ties broken alphabetically for determinism.
 */

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const RANK_NONE = Number.POSITIVE_INFINITY;

/**
 * Lower is better. Multi-word terms match order-independently: EVERY term word
 * must appear (full prefix 0 / word prefix 1 / substring 2) and the rank is
 * the sum, so "olive oil" finds "Oil, olive, salad or cooking".
 */
function rankText(normalizedHaystack: string, normalizedTerm: string): number {
  // Exact phrase gets the best possible treatment first.
  if (normalizedHaystack.startsWith(normalizedTerm)) return 0;
  let total = 0;
  for (const word of normalizedTerm.split(' ')) {
    let wordRank: number;
    if (normalizedHaystack.startsWith(word)) wordRank = 0;
    else if (normalizedHaystack.includes(` ${word}`)) wordRank = 1;
    else if (normalizedHaystack.includes(word)) wordRank = 2;
    else return RANK_NONE;
    total += wordRank;
  }
  return total;
}

export type CatalogSearchResult = { entry: CatalogEntry; rank: number };

export function searchCatalogEntries(
  entries: readonly CatalogEntry[],
  term: string,
  limit: number,
): CatalogEntry[] {
  const normalizedTerm = normalizeSearchText(term);
  if (normalizedTerm.length < 2 || limit <= 0) return [];

  const results: CatalogSearchResult[] = [];
  for (const entry of entries) {
    const names = [entry.nameEn, entry.namePt].filter(
      (n): n is string => typeof n === 'string',
    );
    let rank = RANK_NONE;
    for (const name of names) {
      rank = Math.min(rank, rankText(normalizeSearchText(name), normalizedTerm));
    }
    // Alias matches rank strictly after equivalent name matches (+0.5).
    for (const alias of entry.aliases) {
      const aliasRank = rankText(normalizeSearchText(alias), normalizedTerm);
      if (aliasRank !== RANK_NONE) rank = Math.min(rank, aliasRank + 0.5);
    }
    if (rank !== RANK_NONE) results.push({ entry, rank });
  }

  results.sort(
    (a, b) =>
      a.rank - b.rank || a.entry.nameEn.localeCompare(b.entry.nameEn, 'en'),
  );
  return results.slice(0, limit).map((r) => r.entry);
}
