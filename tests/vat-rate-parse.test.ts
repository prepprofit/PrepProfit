import { describe, expect, it } from 'vitest';
import { parseVatPercent } from '@/lib/validation/vat-rate';
import { ingredientSupplierSchema } from '@/lib/validation/suppliers';

describe('parseVatPercent', () => {
  it('reads blank as unset and 0 as a deliberate rate', () => {
    expect(parseVatPercent('')).toBeNull();
    expect(parseVatPercent('   ')).toBeNull();
    expect(parseVatPercent('0')).toBe(0);
  });

  it('accepts whole and decimal percentages with a comma or point', () => {
    expect(parseVatPercent('14')).toBe(1400);
    expect(parseVatPercent('13,5')).toBe(1350);
    expect(parseVatPercent('25.5 %')).toBe(2550);
    expect(parseVatPercent('100')).toBe(10_000);
  });

  it('rejects negatives, above 100, text and finer than 0.01%', () => {
    for (const bad of ['-1', '100.01', 'abc', '14.555', '1e2']) {
      expect(parseVatPercent(bad)).toBe('invalid');
    }
  });

  it('the supplier payload accepts null, 0 and decimals-as-bps but not fractions of a bp', () => {
    const base = { supplierName: 'Any' };
    expect(ingredientSupplierSchema.safeParse({ ...base, vatRateBps: null }).success).toBe(true);
    expect(ingredientSupplierSchema.safeParse({ ...base, vatRateBps: 0 }).success).toBe(true);
    expect(ingredientSupplierSchema.safeParse({ ...base, vatRateBps: 1350 }).success).toBe(true);
    expect(ingredientSupplierSchema.safeParse({ ...base, vatRateBps: 13.5 }).success).toBe(false);
    expect(ingredientSupplierSchema.safeParse({ ...base, vatRateBps: 10_001 }).success).toBe(false);
  });
});
