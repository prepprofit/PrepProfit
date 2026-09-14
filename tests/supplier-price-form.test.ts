import { describe, expect, it } from 'vitest';
import {
  derivePriceCents,
  parseMoneyText,
  parsePositiveDecimal,
  parseWholeCount,
  suggestPurchaseVat,
} from '@/lib/calculations/supplierPriceForm';

const kg = (packSize: number, packUnit: 'kg' | 'g' = 'kg', unitsPerPack = 1) =>
  ({ unitsPerPack, packSize, packUnit, dimension: 'weight' as const });

describe('derivePriceCents (same VAT basis, either direction)', () => {
  it('price per kg and pack size → pack price, with gram conversion', () => {
    expect(derivePriceCents('unit', 800, kg(2.5))).toBe(2000); // €8/kg × 2.5 kg = €20
    expect(derivePriceCents('unit', 800, kg(500, 'g'))).toBe(400); // €8/kg × 500 g = €4
    expect(derivePriceCents('unit', 800, kg(1.65, 'kg', 4))).toBe(5280); // 4 × 1.65 kg
  });

  it('pack price and pack size → price per kg', () => {
    expect(derivePriceCents('pack', 2000, kg(2.5))).toBe(800);
    expect(derivePriceCents('pack', 400, kg(500, 'g'))).toBe(800);
    expect(derivePriceCents('pack', 199, kg(0.75))).toBe(265); // €1.99 for 750 g → €2.65/kg
  });

  it('works for volume and count without mixing dimensions', () => {
    expect(derivePriceCents('unit', 300, { unitsPerPack: 1, packSize: 330, packUnit: 'ml', dimension: 'volume' })).toBe(99);
    expect(derivePriceCents('pack', 360, { unitsPerPack: 12, packSize: 1, packUnit: 'count', dimension: 'count' })).toBe(30);
    expect(derivePriceCents('unit', 30, { unitsPerPack: 12, packSize: 1, packUnit: 'count', dimension: 'count' })).toBe(360);
  });

  it('returns null for an incomplete pack or a bad price — never zero', () => {
    expect(derivePriceCents('unit', 800, kg(0))).toBeNull();
    expect(derivePriceCents('unit', 800, kg(1, 'kg', 0))).toBeNull();
    expect(derivePriceCents('unit', Number.NaN, kg(1))).toBeNull();
    expect(derivePriceCents('pack', -1, kg(1))).toBeNull();
  });
});

describe('suggestPurchaseVat', () => {
  it('prefers the entry, then the ingredient, band and business default; keeps 0%', () => {
    expect(suggestPurchaseVat({ entryBps: 0, ingredientBps: 1400, bandBps: 2550, businessBps: 1400 })).toEqual({ bps: 0, source: 'entry' });
    expect(suggestPurchaseVat({ entryBps: null, ingredientBps: 1350, bandBps: 2550, businessBps: 1400 })).toEqual({ bps: 1350, source: 'ingredient' });
    expect(suggestPurchaseVat({ entryBps: null, ingredientBps: null, bandBps: 2550, businessBps: 1400 })).toEqual({ bps: 2550, source: 'band' });
    expect(suggestPurchaseVat({ entryBps: null, ingredientBps: null, bandBps: null, businessBps: 1400 })).toEqual({ bps: 1400, source: 'business' });
    expect(suggestPurchaseVat({ entryBps: null, ingredientBps: null, bandBps: null, businessBps: null })).toBeNull();
  });
});

describe('field parsers', () => {
  it('reads decimals with comma or point and rejects the rest', () => {
    expect(parsePositiveDecimal('2,5')).toBe(2.5);
    expect(parsePositiveDecimal('0.5')).toBe(0.5);
    for (const bad of ['', '0', '-1', 'abc', '1e3']) expect(parsePositiveDecimal(bad)).toBeNull();
    expect(parseWholeCount('4')).toBe(4);
    expect(parseWholeCount('1.5')).toBeNull();
    expect(parseMoneyText('19,90')).toBe(1990);
    expect(parseMoneyText('8')).toBe(800);
    expect(parseMoneyText('0')).toBe(0);
    for (const bad of ['', 'abc', '1.234', '-2']) expect(parseMoneyText(bad)).toBeNull();
  });
});
