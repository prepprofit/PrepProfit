import type { CatalogEntry } from './schema';

/**
 * Pure search over the seed ingredient catalogue — tuned so everyday ingredients
 * surface first when a chef types a plain word ("flour", "eggs", "cream").
 *
 * Names come from USDA and read "Head, qualifier, qualifier" ("Oil, olive, salad or
 * cooking"), so matching works on normalized, SINGULARIZED word tokens (eggs → egg,
 * strawberries → strawberry) and ranks by how directly the term names the food:
 *
 *   0    exact: the term IS a curated alias or the whole name
 *   0.5  the term is the name's head ("sugar" → "Sugars, brown") — after curated
 *        aliases, so "sugar" means granulated sugar, not the first sugar variety
 *   1    the head (or an alias) starts with the term
 *   2  every term word is a whole word of the head
 *   3  every term word is a whole word anywhere in the name
 *   4  every term word starts a word in the name
 *   5  every term word appears somewhere (substring)
 *
 * Curated aliases (overrides.json) count as names (a non-exact alias match ranks just
 * after the same match on a real name). Ties prefer SIMPLER entries —
 * fewer comma qualifiers, then shorter names — so "Butter" beats "Butter, whipped"
 * and plain staples beat prepared foods; then alphabetical for determinism.
 * Diacritic- and case-insensitive ("acucar" finds "Açúcar").
 */

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Minimal English singularization — enough for ingredient nouns, never over-eager. */
export function singularize(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`; // berries → berry
  if (/(sses|shes|ches|xes|oes)$/.test(word)) return word.slice(0, -2); // tomatoes → tomato
  if (word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1); // eggs → egg
  return word;
}

function tokens(value: string): string[] {
  const normalized = normalizeSearchText(value);
  return normalized === '' ? [] : normalized.split(' ').map(singularize);
}

const RANK_NONE = Number.POSITIVE_INFINITY;

function startsWithTokens(haystack: string[], needle: string[]): boolean {
  return needle.length <= haystack.length && needle.every((t, i) => haystack[i] === t);
}

/** Rank one name (or alias) against the term tokens; lower is better. */
function rankName(name: string, term: string[], isAlias: boolean): number {
  const all = tokens(name);
  if (all.length === 0) return RANK_NONE;
  const head = tokens(name.split(',')[0] ?? name);
  const joined = term.join(' ');

  if (all.join(' ') === joined) return 0;
  if (head.join(' ') === joined) return 0.5;
  if (startsWithTokens(head, term) || (isAlias && startsWithTokens(all, term))) return 1;
  if (term.every((t) => head.includes(t))) return 2;
  if (term.every((t) => all.includes(t))) return 3;
  if (term.every((t) => all.some((w) => w.startsWith(t)))) return 4;
  const flat = all.join(' ');
  if (term.every((t) => flat.includes(t))) return 5;
  return RANK_NONE;
}

export type CatalogSearchResult = { entry: CatalogEntry; rank: number };

export function searchCatalogEntries(
  entries: readonly CatalogEntry[],
  term: string,
  limit: number,
): CatalogEntry[] {
  if (normalizeSearchText(term).length < 2 || limit <= 0) return [];
  const termTokens = tokens(term);

  const results: CatalogSearchResult[] = [];
  for (const entry of entries) {
    let rank = RANK_NONE;
    for (const name of [entry.nameEn, entry.namePt]) {
      if (name) rank = Math.min(rank, rankName(name, termTokens, false));
    }
    for (const alias of entry.aliases) {
      // An EXACT alias is the curated answer; any looser alias match ranks just after
      // an equally loose match on the real name.
      const aliasRank = rankName(alias, termTokens, true);
      rank = Math.min(rank, aliasRank === 0 ? 0 : aliasRank + 0.25);
    }
    if (rank !== RANK_NONE) results.push({ entry, rank });
  }

  const qualifiers = (e: CatalogEntry) => e.nameEn.split(',').length;
  results.sort(
    (a, b) =>
      a.rank - b.rank ||
      qualifiers(a.entry) - qualifiers(b.entry) ||
      a.entry.nameEn.length - b.entry.nameEn.length ||
      a.entry.nameEn.localeCompare(b.entry.nameEn, 'en'),
  );
  return results.slice(0, limit).map((r) => r.entry);
}
