import { describe, it, expect } from 'vitest';
import { pickSupplierDisplayName, isPackUnitCompatible } from './display-name';

describe('pickSupplierDisplayName', () => {
  it('picks the most frequent raw spelling', () => {
    expect(
      pickSupplierDisplayName(['Acme', 'Acme', 'ACME', 'acme']),
    ).toBe('Acme');
  });

  it('breaks ties lexicographically (smallest first)', () => {
    // 'ACME' and 'Acme' each appear once — uppercase 'A'..'C' sort before
    // lowercase letters, so 'ACME' < 'Acme'.
    expect(pickSupplierDisplayName(['Acme', 'ACME'])).toBe('ACME');
  });

  it('breaks a multi-way tie deterministically', () => {
    // Each appears once; lexicographic winner is the smallest string.
    const names = ['banana foods', 'Apple Foods', 'Cherry Foods'];
    expect(pickSupplierDisplayName(names)).toBe('Apple Foods');
    // Order of input must not matter (idempotent re-run).
    expect(pickSupplierDisplayName([...names].reverse())).toBe('Apple Foods');
  });

  it('returns the single name when there is one', () => {
    expect(pickSupplierDisplayName(['  ACME  Foods '])).toBe('  ACME  Foods ');
  });

  it('returns empty string for an empty group (defensive)', () => {
    expect(pickSupplierDisplayName([])).toBe('');
  });

  it('frequency beats lexicographic order', () => {
    // 'zeta' appears twice, 'alpha' once — frequency wins despite 'alpha' < 'zeta'.
    expect(pickSupplierDisplayName(['zeta', 'zeta', 'alpha'])).toBe('zeta');
  });
});

describe('isPackUnitCompatible', () => {
  it('accepts a weight unit on a weight ingredient', () => {
    expect(isPackUnitCompatible('kg', 'weight')).toBe(true);
    expect(isPackUnitCompatible('lb', 'weight')).toBe(true);
  });

  it('accepts a volume unit on a volume ingredient', () => {
    expect(isPackUnitCompatible('l', 'volume')).toBe(true);
    expect(isPackUnitCompatible('floz', 'volume')).toBe(true);
  });

  it('accepts count on a count ingredient', () => {
    expect(isPackUnitCompatible('count', 'count')).toBe(true);
  });

  it('rejects a weight unit on a volume ingredient', () => {
    expect(isPackUnitCompatible('kg', 'volume')).toBe(false);
    expect(isPackUnitCompatible('l', 'weight')).toBe(false);
    expect(isPackUnitCompatible('count', 'weight')).toBe(false);
  });
});
