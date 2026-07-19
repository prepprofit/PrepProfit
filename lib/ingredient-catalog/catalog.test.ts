import { describe, expect, it } from 'vitest';
import rawCatalog from './data/catalog.json';
import {
  getCatalogEntry,
  getIngredientCatalog,
  searchIngredientCatalog,
} from './index';
import { catalogSchema, type CatalogEntry } from './schema';
import { normalizeSearchText, searchCatalogEntries } from './search';

describe('seed ingredient catalog dataset', () => {
  it('validates the entire committed dataset (Zod, unique ids)', () => {
    const parsed = catalogSchema.parse(rawCatalog);
    expect(parsed.length).toBeGreaterThanOrEqual(1500);
    expect(parsed.length).toBeLessThanOrEqual(2500);
  });

  it('loads and memoizes via getIngredientCatalog', () => {
    expect(getIngredientCatalog()).toBe(getIngredientCatalog());
  });

  it('contains no price-shaped fields — prices never come from the catalog', () => {
    for (const entry of rawCatalog as Record<string, unknown>[]) {
      for (const key of Object.keys(entry)) {
        expect(key.toLowerCase()).not.toContain('price');
        expect(key.toLowerCase()).not.toContain('cost');
      }
    }
  });

  it('finds staples every kitchen needs', () => {
    for (const term of ['salt', 'butter', 'olive oil', 'flour', 'egg']) {
      expect(searchIngredientCatalog(term).length).toBeGreaterThan(0);
    }
  });

  it('resolves an entry by id and misses unknown ids', () => {
    const first = getIngredientCatalog()[0];
    if (!first) throw new Error('empty catalog');
    expect(getCatalogEntry(first.id)?.id).toBe(first.id);
    expect(getCatalogEntry('definitely-not-a-real-id')).toBeNull();
  });
});

describe('normalizeSearchText', () => {
  it('strips diacritics and case', () => {
    expect(normalizeSearchText('Açúcar')).toBe('acucar');
    expect(normalizeSearchText('  Crème  Fraîche ')).toBe('creme fraiche');
  });

  it('collapses punctuation to single spaces', () => {
    expect(normalizeSearchText("baker's, active-dry")).toBe('baker s active dry');
  });
});

describe('searchCatalogEntries', () => {
  const entry = (over: Partial<CatalogEntry> & { id: string }): CatalogEntry => ({
    nameEn: over.id,
    aliases: [],
    dimension: 'weight',
    category: 'Test',
    allergens: [],
    suggestedFdcId: null,
    ...over,
  });
  const fixtures: CatalogEntry[] = [
    entry({ id: 'butter', nameEn: 'Butter' }),
    entry({ id: 'peanut-butter', nameEn: 'Peanut butter' }),
    entry({ id: 'butternut-squash', nameEn: 'Butternut squash' }),
    entry({ id: 'ghee', nameEn: 'Ghee', aliases: ['clarified butter'] }),
    entry({ id: 'acucar', nameEn: 'Sugar', namePt: 'Açúcar' }),
  ];

  it('ranks whole-name prefix over word prefix over substring', () => {
    const ids = searchCatalogEntries(fixtures, 'butter', 10).map((e) => e.id);
    expect(ids[0]).toBe('butter');
    expect(ids.indexOf('peanut-butter')).toBeLessThan(
      ids.indexOf('butternut-squash') === -1 ? Infinity : ids.indexOf('ghee'),
    );
    expect(ids).toContain('ghee'); // alias match, ranked after name matches
  });

  it('matches diacritic-insensitively across namePt', () => {
    expect(searchCatalogEntries(fixtures, 'acucar', 5)[0]?.id).toBe('acucar');
    expect(searchCatalogEntries(fixtures, 'açúcar', 5)[0]?.id).toBe('acucar');
  });

  it('returns [] for short or empty terms and non-positive limits', () => {
    expect(searchCatalogEntries(fixtures, 'b', 5)).toEqual([]);
    expect(searchCatalogEntries(fixtures, '   ', 5)).toEqual([]);
    expect(searchCatalogEntries(fixtures, 'butter', 0)).toEqual([]);
  });

  it('caps results at the limit deterministically', () => {
    const two = searchCatalogEntries(fixtures, 'butter', 2);
    expect(two).toHaveLength(2);
    expect(two[0]?.id).toBe('butter');
  });
});
