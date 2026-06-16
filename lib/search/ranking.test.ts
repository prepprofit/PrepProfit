import { describe, it, expect } from 'vitest';
import {
  MIN_QUERY_LEN,
  isSearchable,
  makeSnippet,
  normalizeQuery,
  rankCandidates,
  scoreCandidate,
} from './ranking';
import type { SearchCandidate } from './types';

/** Build a candidate with sensible defaults; override only what a test cares about. */
function candidate(over: Partial<SearchCandidate>): SearchCandidate {
  return {
    id: 'id',
    title: 'title',
    subtitle: null,
    href: '/x',
    primarySim: 0,
    secondarySim: 0,
    exact: false,
    prefix: false,
    substring: false,
    ...over,
  };
}

describe('normalizeQuery', () => {
  it('trims and collapses internal whitespace', () => {
    expect(normalizeQuery('  choc   cake  ')).toBe('choc cake');
    expect(normalizeQuery('\tflour\n')).toBe('flour');
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(normalizeQuery('   ')).toBe('');
  });
});

describe('isSearchable', () => {
  it(`is false below ${MIN_QUERY_LEN} chars`, () => {
    expect(isSearchable('')).toBe(false);
    expect(isSearchable('a')).toBe(false);
  });

  it('is true at or above the minimum length', () => {
    expect(isSearchable('ab')).toBe(true);
    expect(isSearchable('flour')).toBe(true);
  });
});

describe('scoreCandidate', () => {
  it('orders exact > prefix > substring > fuzzy regardless of similarity', () => {
    // Fuzzy gets a maxed-out similarity; it must still rank below a substring.
    const fuzzy = scoreCandidate(candidate({ primarySim: 1, secondarySim: 1 }));
    const substring = scoreCandidate(candidate({ substring: true }));
    const prefix = scoreCandidate(candidate({ prefix: true, substring: true }));
    const exact = scoreCandidate(
      candidate({ exact: true, prefix: true, substring: true }),
    );
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(fuzzy);
  });

  it('weights the primary column above the secondary', () => {
    const primary = scoreCandidate(candidate({ primarySim: 0.5 }));
    const secondary = scoreCandidate(candidate({ secondarySim: 0.5 }));
    expect(primary).toBeGreaterThan(secondary);
  });
});

describe('rankCandidates', () => {
  it('returns [] for no candidates', () => {
    expect(rankCandidates('recipe', [])).toEqual([]);
  });

  it('puts the typo-tolerant best match first (trigram relevance order)', () => {
    // "chocolat mouse" typo: "Chocolate Mousse" scores highest by similarity.
    const results = rankCandidates('recipe', [
      candidate({ id: 'a', title: 'Sourdough Bread', primarySim: 0.05 }),
      candidate({ id: 'b', title: 'Chocolate Mousse', primarySim: 0.68 }),
      candidate({ id: 'c', title: 'Raspberry Tart', primarySim: 0.1 }),
    ]);
    expect(results.map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(results[0]?.type).toBe('recipe');
  });

  it('ranks an exact/prefix hit above a higher-similarity fuzzy one', () => {
    const results = rankCandidates('ingredient', [
      candidate({ id: 'fuzzy', title: 'Floral honey', primarySim: 0.9 }),
      candidate({ id: 'prefix', title: 'Flour', prefix: true, substring: true, primarySim: 0.4 }),
    ]);
    expect(results[0]?.id).toBe('prefix');
  });

  it('breaks score ties deterministically by title then id', () => {
    const results = rankCandidates('recipe', [
      candidate({ id: '2', title: 'Bbb', substring: true }),
      candidate({ id: '1', title: 'Aaa', substring: true }),
      candidate({ id: '3', title: 'Aaa', substring: true }),
    ]);
    expect(results.map((r) => r.id)).toEqual(['1', '3', '2']);
  });
});

describe('makeSnippet', () => {
  it('returns short text unchanged', () => {
    expect(makeSnippet('Catering event', 'cater', 80)).toBe('Catering event');
  });

  it('collapses whitespace', () => {
    expect(makeSnippet('  a   b  ', 'a', 80)).toBe('a b');
  });

  it('windows around the match with ellipses on both sides', () => {
    const text =
      'Quarterly bulk order of premium organic flour from the regional mill cooperative supplier';
    const snippet = makeSnippet(text, 'flour', 30);
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.toLowerCase()).toContain('flour');
    expect(snippet.length).toBeLessThanOrEqual(32); // 30 + two ellipsis chars
  });

  it('falls back to a leading slice when the match is absent', () => {
    const text = 'a'.repeat(200);
    const snippet = makeSnippet(text, 'zzz', 20);
    expect(snippet).toBe(`${'a'.repeat(20)}…`);
  });
});
