import { describe, expect, it } from 'vitest';
import { ingredientMatchesQuery } from '@/lib/ingredients/search';
import type { DefaultSupplierSummary } from '@/lib/data/ingredient-suppliers';

const link = (overrides: Partial<DefaultSupplierSummary> = {}): DefaultSupplierSummary => ({
  supplierName: 'Sallinen',
  packSize: 13.5,
  packUnit: 'kg',
  packPriceCents: 4200,
  unitsPerPack: 1,
  supplierProductName: 'Mantelijauhe 13,5 kg',
  supplierSku: '00482-A',
  vatRateBps: 1400,
  ...overrides,
});

describe('ingredientMatchesQuery', () => {
  it('matches the ingredient’s own name, case-insensitively', () => {
    expect(ingredientMatchesQuery({ name: 'Almond flour', supplier: null }, null, 'almond')).toBe(true);
    expect(ingredientMatchesQuery({ name: 'Almond flour', supplier: null }, null, 'ALMOND')).toBe(true);
    expect(ingredientMatchesQuery({ name: 'Almond flour', supplier: null }, null, 'oat')).toBe(false);
  });

  it('matches the displayed supplier name even with no link loaded (kitchen)', () => {
    expect(ingredientMatchesQuery({ name: 'Almond flour', supplier: 'Sallinen' }, null, 'sallinen')).toBe(true);
    expect(ingredientMatchesQuery({ name: 'Almond flour', supplier: 'Sallinen' }, null, 'metro')).toBe(false);
  });

  it('matches the supplier product name and code from the default link (manager)', () => {
    const row = { name: 'Almond flour', supplier: 'Sallinen' };
    expect(ingredientMatchesQuery(row, link(), 'mantelijauhe')).toBe(true);
    expect(ingredientMatchesQuery(row, link(), '00482-A')).toBe(true);
    // A leading zero in the code is preserved, not stripped as a number would be.
    expect(ingredientMatchesQuery(row, link(), '00482')).toBe(true);
  });

  it('finds the ingredient by either its own name or the supplier’s product name', () => {
    const row = { name: 'Almond flour', supplier: 'Sallinen' };
    expect(ingredientMatchesQuery(row, link(), 'almond flour')).toBe(true);
    expect(ingredientMatchesQuery(row, link(), 'mantelijauhe')).toBe(true);
  });

  it('ignores a supplier’s product name/code when no link is loaded for this viewer', () => {
    const row = { name: 'Almond flour', supplier: 'Sallinen' };
    expect(ingredientMatchesQuery(row, null, 'mantelijauhe')).toBe(false);
  });

  it('an empty query matches every row', () => {
    expect(ingredientMatchesQuery({ name: 'Almond flour', supplier: null }, null, '')).toBe(true);
    expect(ingredientMatchesQuery({ name: 'Almond flour', supplier: null }, null, '   ')).toBe(true);
  });

  it('a non-matching query excludes an unassigned-supplier row', () => {
    expect(ingredientMatchesQuery({ name: 'Almond flour', supplier: null }, null, 'sallinen')).toBe(false);
  });
});
