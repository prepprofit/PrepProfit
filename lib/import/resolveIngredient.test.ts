import { describe, it, expect } from 'vitest';
import {
  normalizeIngredientName,
  diceSimilarity,
  resolveIngredient,
  FUZZY_THRESHOLD,
  type IngredientCandidate,
} from './resolveIngredient';

/**
 * Pure resolver tests (Sprint 4.6). No DB. Covers normalization (accents / case /
 * whitespace / punctuation), Dice similarity, and the exact / fuzzy / new
 * outcomes — including the rule that fuzzy is NEVER an auto-link.
 */

describe('normalizeIngredientName', () => {
  it('lowercases, trims, and collapses whitespace', () => {
    expect(normalizeIngredientName('  Olive   Oil  ')).toBe('olive oil');
  });

  it('strips diacritics', () => {
    expect(normalizeIngredientName('Farinha Açúcar Manteiga')).toBe(
      'farinha acucar manteiga',
    );
    expect(normalizeIngredientName('Crème Fraîche')).toBe('creme fraiche');
  });

  it('treats punctuation as a separator', () => {
    expect(normalizeIngredientName('Flour T-55 (organic)')).toBe('flour t 55 organic');
    expect(normalizeIngredientName('Sugar, white')).toBe('sugar white');
  });

  it('is idempotent', () => {
    const once = normalizeIngredientName('  Tomate  Pelado!! ');
    expect(normalizeIngredientName(once)).toBe(once);
  });
});

describe('diceSimilarity', () => {
  it('is 1 for identical normalized strings', () => {
    expect(diceSimilarity('flour', 'flour')).toBe(1);
  });

  it('is 0 when one side is empty', () => {
    expect(diceSimilarity('', 'flour')).toBe(0);
    expect(diceSimilarity('flour', '')).toBe(0);
  });

  it('rises for closer strings', () => {
    const near = diceSimilarity('tomato', 'tomatos');
    const far = diceSimilarity('tomato', 'butter');
    expect(near).toBeGreaterThan(far);
    expect(near).toBeGreaterThan(0.7);
    expect(far).toBeLessThan(0.3);
  });
});

const candidates: IngredientCandidate[] = [
  { id: 'i1', name: 'Olive Oil' },
  { id: 'i2', name: 'Flour T55' },
  { id: 'i3', name: 'Tomato' },
  { id: 'i4', name: 'Sugar' },
];

describe('resolveIngredient — exact', () => {
  it('auto-links an exact normalized match (accent / case / space insensitive)', () => {
    const out = resolveIngredient('  olive   oil ', candidates);
    expect(out).toEqual({ kind: 'exact', ingredientId: 'i1', name: 'Olive Oil' });
  });

  it('matches across diacritics', () => {
    const out = resolveIngredient('Tomáto', [{ id: 'x', name: 'Tomato' }]);
    expect(out.kind).toBe('exact');
  });

  it('never auto-links an empty name', () => {
    const out = resolveIngredient('   ', candidates);
    expect(out.kind).toBe('new');
  });
});

describe('resolveIngredient — fuzzy', () => {
  it('offers ranked suggestions but never auto-links', () => {
    const out = resolveIngredient('Flour T-55', candidates);
    expect(out.kind).toBe('fuzzy');
    if (out.kind !== 'fuzzy') throw new Error('expected fuzzy');
    expect(out.suggestions[0]!.ingredientId).toBe('i2');
    expect(out.suggestions.every((s) => s.score >= FUZZY_THRESHOLD)).toBe(true);
  });

  it('ranks the best candidate first and caps at 3', () => {
    const many: IngredientCandidate[] = [
      { id: 'a', name: 'Tomato' },
      { id: 'b', name: 'Tomatos' },
      { id: 'c', name: 'Tomate' },
      { id: 'd', name: 'Tomatto' },
    ];
    // A near-but-not-exact target exercises ranking + the cap.
    const out = resolveIngredient('Tomatoz', many, { threshold: 0 });
    if (out.kind !== 'fuzzy') throw new Error('expected fuzzy');
    expect(out.suggestions.length).toBeLessThanOrEqual(3);
    const scores = out.suggestions.map((s) => s.score);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
  });

  it('breaks score ties deterministically by name', () => {
    // Symmetric candidates ('a…' vs 'b…' prefix) score identically against the
    // target, so the only differentiator is the name tiebreak. threshold:0 keeps
    // both regardless of absolute score.
    const out = resolveIngredient('tomato', [
      { id: 'b', name: 'btomato' },
      { id: 'a', name: 'atomato' },
    ], { threshold: 0 });
    if (out.kind !== 'fuzzy') throw new Error('expected fuzzy');
    expect(out.suggestions[0]!.score).toBe(out.suggestions[1]!.score);
    expect(out.suggestions[0]!.name).toBe('atomato');
  });
});

describe('resolveIngredient — new', () => {
  it('returns new when nothing clears the threshold', () => {
    const out = resolveIngredient('Saffron threads', candidates);
    expect(out.kind).toBe('new');
  });

  it('returns new against an empty candidate list', () => {
    expect(resolveIngredient('Anything', []).kind).toBe('new');
  });
});
