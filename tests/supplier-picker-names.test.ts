import { describe, expect, it } from 'vitest';
import { supplierPickerNames } from '@/lib/suppliers/picker-names';

describe('supplierPickerNames', () => {
  it('offers records plus supplier names already on ingredients, deduped case-insensitively', () => {
    const names = supplierPickerNames(
      ['METRO', 'MYLLÄRIN', 'JHB', 'k super'],
      ['LT', 'lt', 'Myllärin', 'SALLINEN', null, '  ', 'metro', 'ÅSÖ', 'AIMO'],
    );
    expect(names).toHaveLength(8);
    // Record spelling wins; alphabetical, locale-aware, no special first position.
    expect(names.filter((n) => n !== 'ÅSÖ')).toEqual(['AIMO', 'JHB', 'k super', 'LT', 'METRO', 'MYLLÄRIN', 'SALLINEN']);
    expect(names).toContain('ÅSÖ'); // where Å sorts depends on the locale's alphabet
  });
});
