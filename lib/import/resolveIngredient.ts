/**
 * Pure ingredient name RESOLVER for recipe import (Sprint 4.6).
 *
 * Given a raw ingredient name from an import file and the list of the org's
 * ACTIVE ingredients (passed in by the data layer — this module never touches the
 * DB), decide one of three outcomes:
 *   - `exact`: the name matches an existing ingredient after normalization
 *     (case / accent / whitespace insensitive). Auto-linked at confirm.
 *   - `fuzzy`: no exact match, but one or more close candidates (trigram Dice
 *     similarity ≥ THRESHOLD). Returned as ranked SUGGESTIONS only — never an
 *     automatic link (CLAUDE.md: fuzzy is a suggestion, the manager must choose).
 *   - `new`: nothing close enough → stage a new ingredient (priceCents 0, needs
 *     pricing) once the manager confirms.
 *
 * Self-contained and deterministic so it unit-tests without a database. The
 * similarity is a classic Sørensen–Dice coefficient over character trigrams of
 * the normalized strings; pg_trgm stays for live global search, but the import
 * resolver does NOT depend on it.
 */

/** A candidate existing ingredient the resolver may match against. */
export type IngredientCandidate = {
  id: string;
  name: string;
};

/** One ranked fuzzy suggestion: an existing ingredient and its similarity. */
export type IngredientSuggestion = {
  ingredientId: string;
  /** The candidate's display name (for the resolution UI). */
  name: string;
  /** Sørensen–Dice similarity in [0, 1], rounded to 4 dp for stable storage. */
  score: number;
};

export type ResolveOutcome =
  | { kind: 'exact'; ingredientId: string; name: string }
  | { kind: 'fuzzy'; suggestions: IngredientSuggestion[] }
  | { kind: 'new' };

/** Similarity at/above which a candidate is offered as a fuzzy suggestion. */
export const FUZZY_THRESHOLD = 0.7;

/** Max fuzzy suggestions returned (best-ranked first). */
export const MAX_SUGGESTIONS = 3;

/**
 * Normalize a name for matching: lowercase, strip diacritics, drop punctuation,
 * and collapse internal whitespace. `"  Farinha   T-55 (½)  "` → `"farinha t55"`.
 * Pure and idempotent; used for BOTH exact comparison and trigram generation so
 * the two stay consistent.
 */
export function normalizeIngredientName(raw: string): string {
  return raw
    .normalize('NFD')
    // Strip combining diacritical marks (accents) left by NFD (U+0300–U+036F).
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Anything that is not a letter, digit or space becomes a separator.
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Character trigrams of a normalized string, padded pg_trgm-style (two leading
 * spaces, one trailing) so short names still yield stable trigrams. Returns a
 * multiset as a count map (repeated trigrams count once each for Dice).
 */
function trigrams(normalized: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (normalized === '') return counts;
  const padded = `  ${normalized} `;
  for (let i = 0; i + 3 <= padded.length; i++) {
    const gram = padded.slice(i, i + 3);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/** Total size of a trigram multiset. */
function multisetSize(counts: Map<string, number>): number {
  let total = 0;
  for (const n of counts.values()) total += n;
  return total;
}

/**
 * Sørensen–Dice similarity in [0, 1] between two ALREADY-normalized strings,
 * over their trigram multisets. Two empty strings are perfectly similar (1);
 * one empty vs non-empty is 0.
 */
export function diceSimilarity(aNormalized: string, bNormalized: string): number {
  if (aNormalized === bNormalized) return 1;
  const a = trigrams(aNormalized);
  const b = trigrams(bNormalized);
  const sizeA = multisetSize(a);
  const sizeB = multisetSize(b);
  if (sizeA === 0 || sizeB === 0) return 0;

  let intersection = 0;
  for (const [gram, countA] of a) {
    const countB = b.get(gram);
    if (countB !== undefined) intersection += Math.min(countA, countB);
  }
  return (2 * intersection) / (sizeA + sizeB);
}

/** Round a score to 4 dp so stored/serialized suggestions stay stable. */
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/**
 * Resolve one imported ingredient name against the org's active ingredients.
 *
 * Exact (normalized) match short-circuits to `exact` (the first such candidate).
 * Otherwise candidates scoring ≥ THRESHOLD become ranked `fuzzy` suggestions
 * (top {@link MAX_SUGGESTIONS}, highest first; ties broken by name for
 * determinism). Nothing close enough → `new`.
 */
export function resolveIngredient(
  rawName: string,
  candidates: readonly IngredientCandidate[],
  options: { threshold?: number; maxSuggestions?: number } = {},
): ResolveOutcome {
  const threshold = options.threshold ?? FUZZY_THRESHOLD;
  const maxSuggestions = options.maxSuggestions ?? MAX_SUGGESTIONS;
  const target = normalizeIngredientName(rawName);

  // Precompute normalized candidate names once.
  const normalized = candidates.map((c) => ({
    candidate: c,
    norm: normalizeIngredientName(c.name),
  }));

  // Exact (normalized) match wins outright — the only auto-link path.
  const exact = normalized.find((c) => c.norm === target && target !== '');
  if (exact) {
    return { kind: 'exact', ingredientId: exact.candidate.id, name: exact.candidate.name };
  }

  const scored = normalized
    .map((c) => ({
      ingredientId: c.candidate.id,
      name: c.candidate.name,
      score: round4(diceSimilarity(target, c.norm)),
    }))
    .filter((s) => s.score >= threshold)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, maxSuggestions);

  if (scored.length === 0) return { kind: 'new' };
  return { kind: 'fuzzy', suggestions: scored };
}
