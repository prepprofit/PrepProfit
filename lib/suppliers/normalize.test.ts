import { describe, expect, it } from 'vitest';
import { normalizeSupplierName } from './normalize';

/**
 * Sprint F6 — the supplier dedup key. The same key must come out regardless of
 * case, surrounding whitespace, or internal whitespace runs; blank → '' (invalid,
 * callers reject). This is the single source of truth Sprint 7's `normalized_name`
 * column + `unique (org, normalized_name)`, the backfill, and imports all use.
 */
describe('normalizeSupplierName', () => {
  it('lowercases and trims', () => {
    expect(normalizeSupplierName('  ACME Foods  ')).toBe('acme foods');
    expect(normalizeSupplierName('Acme Foods')).toBe('acme foods');
  });

  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeSupplierName('ACME   Foods')).toBe('acme foods');
    expect(normalizeSupplierName('acme\tfoods')).toBe('acme foods');
    expect(normalizeSupplierName('  ACME   Foods ')).toBe('acme foods');
  });

  it('maps casing/spacing variants to ONE key', () => {
    const variants = ['ACME', 'Acme', 'acme', '  acme  '];
    const keys = new Set(variants.map(normalizeSupplierName));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe('acme');
  });

  it('returns the empty key for blank / whitespace-only names (callers reject)', () => {
    expect(normalizeSupplierName('')).toBe('');
    expect(normalizeSupplierName('   ')).toBe('');
    expect(normalizeSupplierName('\t\n')).toBe('');
  });
});
