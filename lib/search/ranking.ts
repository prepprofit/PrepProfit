import type {
  SearchCandidate,
  SearchEntityType,
  SearchResult,
} from './types';

/**
 * Pure ranking + snippet helpers for global search (Sprint 2.7). No DB, no I/O —
 * the SQL layer returns raw signals (trigram similarity + ILIKE flags) and these
 * functions turn them into a stable, relevance-ordered result list. Unit-tested
 * in `ranking.test.ts` (CLAUDE.md: ranking/snippet logic lives in lib/ + Vitest).
 */

/** Shortest query we run a search for — below this the noise outweighs signal. */
export const MIN_QUERY_LEN = 2;

/** Trim and collapse internal whitespace so " choc  cake " → "choc cake". */
export function normalizeQuery(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** True once a normalized query is long enough to be worth searching. */
export function isSearchable(normalized: string): boolean {
  return normalized.length >= MIN_QUERY_LEN;
}

/**
 * Relevance score for one candidate. The additive bands guarantee the ordering
 * exact > prefix > substring > fuzzy regardless of similarity, while similarity
 * breaks ties within a band and weights the primary column above the secondary.
 */
export function scoreCandidate(c: SearchCandidate): number {
  return (
    (c.exact ? 1000 : 0) +
    (c.prefix ? 100 : 0) +
    (c.substring ? 10 : 0) +
    c.primarySim * 5 +
    c.secondarySim * 2
  );
}

/**
 * Score, sort (desc) and shape candidates into results. Deterministic: ties on
 * score fall back to title then id, so tests and the UI never flicker on order.
 */
export function rankCandidates(
  type: SearchEntityType,
  candidates: SearchCandidate[],
): SearchResult[] {
  return candidates
    .map((c) => ({
      type,
      id: c.id,
      title: c.title,
      subtitle: c.subtitle,
      href: c.href,
      score: scoreCandidate(c),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id),
    );
}

/**
 * A compact, single-line snippet of `text` centered on the first match of
 * `query`, capped at `maxLen` with ellipses. Used for note/notes context lines.
 * No match (or short text) → a plain leading slice.
 */
export function makeSnippet(text: string, query: string, maxLen = 80): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;

  const idx = clean.toLowerCase().indexOf(query.toLowerCase());
  if (idx <= 0) return `${clean.slice(0, maxLen).trimEnd()}…`;

  const start = Math.max(0, idx - Math.floor((maxLen - query.length) / 2));
  const end = Math.min(clean.length, start + maxLen);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < clean.length ? '…' : '';
  return `${prefix}${clean.slice(start, end).trim()}${suffix}`;
}
