import { describe, expect, it } from 'vitest';
import {
  approvedPriceCents,
  InvalidPackSizeError,
  packPriceExclVatCents,
  quotedPriceCents,
  supplierUnitCost,
  type SupplierPriceEntry,
} from './purchasePrice';

/**
 * Sprint F2 — pack price → approved cost per priced unit (per kg / litre / piece).
 * The worked examples prove the v2 cents/gram bug is gone.
 */
describe('approvedPriceCents — worked examples (spec §4 F2)', () => {
  it('1 kg @ €5 → 500 c/kg', () => {
    expect(
      approvedPriceCents({
        packPriceCents: 500,
        packSize: 1,
        packUnit: 'kg',
        dimension: 'weight',
      }),
    ).toBe(500);
  });

  it('5 kg @ €20 → 400 c/kg', () => {
    expect(
      approvedPriceCents({
        packPriceCents: 2000,
        packSize: 5,
        packUnit: 'kg',
        dimension: 'weight',
      }),
    ).toBe(400);
  });

  it('500 ml @ €2 → 400 c/l', () => {
    expect(
      approvedPriceCents({
        packPriceCents: 200,
        packSize: 500,
        packUnit: 'ml',
        dimension: 'volume',
      }),
    ).toBe(400);
  });

  it('12 pcs @ €3 → 25 c/piece', () => {
    expect(
      approvedPriceCents({
        packPriceCents: 300,
        packSize: 12,
        packUnit: 'count',
        dimension: 'count',
      }),
    ).toBe(25);
  });
});

describe('approvedPriceCents — dimensions & units', () => {
  it('handles grams (canonical weight unit)', () => {
    // 250 g @ €1 → 100 × 1000 ÷ 250 = 400 c/kg
    expect(
      approvedPriceCents({
        packPriceCents: 100,
        packSize: 250,
        packUnit: 'g',
        dimension: 'weight',
      }),
    ).toBe(400);
  });

  it('handles litres directly', () => {
    // 2 l @ €6 → 600 × 1000 ÷ 2000 = 300 c/l
    expect(
      approvedPriceCents({
        packPriceCents: 600,
        packSize: 2,
        packUnit: 'l',
        dimension: 'volume',
      }),
    ).toBe(300);
  });
});

describe('approvedPriceCents — rounding & money edges', () => {
  it('rounds half-up to whole cents', () => {
    // 3 pcs @ €1 → 100 × 1 ÷ 3 = 33.33 → 33
    expect(
      approvedPriceCents({
        packPriceCents: 100,
        packSize: 3,
        packUnit: 'count',
        dimension: 'count',
      }),
    ).toBe(33);
    // 8 pcs @ €1 → 100 ÷ 8 = 12.5 → 13 (half-up)
    expect(
      approvedPriceCents({
        packPriceCents: 100,
        packSize: 8,
        packUnit: 'count',
        dimension: 'count',
      }),
    ).toBe(13);
  });

  it('handles a zero pack price (free sample) → 0', () => {
    expect(
      approvedPriceCents({
        packPriceCents: 0,
        packSize: 5,
        packUnit: 'kg',
        dimension: 'weight',
      }),
    ).toBe(0);
  });

  it('handles a large pack price without overflow', () => {
    // 1 kg @ €1,000,000 → 100_000_000 c/kg
    expect(
      approvedPriceCents({
        packPriceCents: 100_000_000,
        packSize: 1,
        packUnit: 'kg',
        dimension: 'weight',
      }),
    ).toBe(100_000_000);
  });
});

describe('approvedPriceCents — invalid pack guard (decision #2)', () => {
  it('throws InvalidPackSizeError on a zero pack size', () => {
    expect(() =>
      approvedPriceCents({
        packPriceCents: 500,
        packSize: 0,
        packUnit: 'kg',
        dimension: 'weight',
      }),
    ).toThrow(InvalidPackSizeError);
  });

  it('throws on a negative pack size', () => {
    expect(() =>
      approvedPriceCents({
        packPriceCents: 500,
        packSize: -1,
        packUnit: 'kg',
        dimension: 'weight',
      }),
    ).toThrow(InvalidPackSizeError);
  });

  it('throws on NaN pack size (never a silent 0 cost)', () => {
    expect(() =>
      approvedPriceCents({
        packPriceCents: 500,
        packSize: Number.NaN,
        packUnit: 'kg',
        dimension: 'weight',
      }),
    ).toThrow(InvalidPackSizeError);
  });
});

/**
 * Supplier quote → whole-pack net price → cost per priced unit. The reference case
 * is a 4 × 1.65 kg case of almond flour at €80 net with a 23% org VAT rate:
 * total 6.6 kg → 1212 c/kg excl. VAT → 1491 c/kg incl.
 */
const CASE: SupplierPriceEntry = {
  priceCents: 8000,
  basis: 'pack',
  includesVat: false,
  taxRateBps: 2300,
  unitsPerPack: 4,
  packSize: 1.65,
  packUnit: 'kg',
  dimension: 'weight',
};

describe('packPriceExclVatCents — bases', () => {
  it('per pack: the entered price IS the whole purchase', () => {
    expect(packPriceExclVatCents(CASE)).toBe(8000);
  });

  it('per inner unit: scales by the case quantity', () => {
    expect(packPriceExclVatCents({ ...CASE, basis: 'inner', priceCents: 2000 })).toBe(
      8000,
    );
  });

  it('per priced unit: scales by the total quantity (6.6 kg)', () => {
    expect(packPriceExclVatCents({ ...CASE, basis: 'priced', priceCents: 1212 })).toBe(
      7999,
    );
  });

  it('a single-item purchase (unitsPerPack 1) is the pre-case behaviour', () => {
    expect(
      packPriceExclVatCents({ ...CASE, unitsPerPack: 1, packSize: 5, priceCents: 2000 }),
    ).toBe(2000);
  });
});

describe('packPriceExclVatCents — VAT', () => {
  it('strips a gross quote at the org rate (€98.40 incl @ 23% → €80)', () => {
    expect(packPriceExclVatCents({ ...CASE, includesVat: true, priceCents: 9840 })).toBe(
      8000,
    );
  });

  it('returns null for a gross quote when no VAT rate is configured', () => {
    expect(
      packPriceExclVatCents({
        ...CASE,
        includesVat: true,
        priceCents: 9840,
        taxRateBps: null,
      }),
    ).toBeNull();
  });

  it('a net quote needs no rate at all', () => {
    expect(packPriceExclVatCents({ ...CASE, taxRateBps: null })).toBe(8000);
  });

  it('a 0% configured rate is honoured (not treated as missing)', () => {
    expect(
      packPriceExclVatCents({ ...CASE, includesVat: true, taxRateBps: 0 }),
    ).toBe(8000);
  });
});

describe('supplierUnitCost — the live readout', () => {
  it('derives 1212 c/kg excl. and 1491 c/kg incl. for the reference case', () => {
    expect(supplierUnitCost(CASE)).toEqual({
      packPriceExclVatCents: 8000,
      perPricedUnitExclVatCents: 1212,
      perPricedUnitInclVatCents: 1491,
    });
  });

  it('a forgotten case quantity jumps out (4× the cost per kg)', () => {
    expect(supplierUnitCost({ ...CASE, unitsPerPack: 1 })).toMatchObject({
      perPricedUnitExclVatCents: 4848,
    });
  });

  it('leaves the incl. VAT line null when no rate is configured', () => {
    expect(supplierUnitCost({ ...CASE, taxRateBps: null })).toEqual({
      packPriceExclVatCents: 8000,
      perPricedUnitExclVatCents: 1212,
      perPricedUnitInclVatCents: null,
    });
  });

  it('returns null when the net price is unknowable', () => {
    expect(
      supplierUnitCost({ ...CASE, includesVat: true, taxRateBps: null }),
    ).toBeNull();
  });

  it('a free sample costs 0, not NaN', () => {
    expect(supplierUnitCost({ ...CASE, priceCents: 0 })).toMatchObject({
      perPricedUnitExclVatCents: 0,
      perPricedUnitInclVatCents: 0,
    });
  });

  it('handles a large purchase without losing cents', () => {
    expect(
      supplierUnitCost({ ...CASE, priceCents: 100_000_000 }),
    ).toMatchObject({ perPricedUnitExclVatCents: 15_151_515 });
  });

  it('counts price per piece, not per kg', () => {
    expect(
      supplierUnitCost({
        ...CASE,
        unitsPerPack: 12,
        packSize: 1,
        packUnit: 'count',
        dimension: 'count',
        priceCents: 300,
      }),
    ).toMatchObject({ perPricedUnitExclVatCents: 25 });
  });
});

describe('supplierUnitCost — invalid pack guard', () => {
  it('throws on a zero case quantity (never divides by zero)', () => {
    expect(() => supplierUnitCost({ ...CASE, unitsPerPack: 0 })).toThrow(
      InvalidPackSizeError,
    );
  });

  it('throws on a NaN pack size', () => {
    expect(() => supplierUnitCost({ ...CASE, packSize: Number.NaN })).toThrow(
      InvalidPackSizeError,
    );
  });
});

/**
 * The editor reopens a saved link and must show the number the manager typed, not
 * the normalized whole-pack net one. `quotedPriceCents` is that inverse.
 */
describe('quotedPriceCents — redisplaying a stored price', () => {
  const stored = { ...CASE, packPriceExclVatCents: 8000 };

  it('per pack: the stored price IS the quote', () => {
    expect(quotedPriceCents(stored)).toBe(8000);
  });

  it('per inner unit: divides by the case quantity', () => {
    expect(quotedPriceCents({ ...stored, basis: 'inner' })).toBe(2000);
  });

  it('per priced unit: the cost per kg (6.6 kg → 1212)', () => {
    expect(quotedPriceCents({ ...stored, basis: 'priced' })).toBe(1212);
  });

  it('adds VAT back for a gross-quoting supplier', () => {
    expect(quotedPriceCents({ ...stored, includesVat: true })).toBe(9840);
  });

  it('returns null when a gross display has no rate to use', () => {
    expect(
      quotedPriceCents({ ...stored, includesVat: true, taxRateBps: null }),
    ).toBeNull();
  });

  it('round-trips every basis back through packPriceExclVatCents', () => {
    for (const basis of ['pack', 'inner', 'priced'] as const) {
      for (const includesVat of [false, true]) {
        const shown = quotedPriceCents({ ...stored, basis, includesVat });
        expect(shown).not.toBeNull();
        expect(
          packPriceExclVatCents({ ...CASE, basis, includesVat, priceCents: shown! }),
        ).toBeCloseTo(8000, -1);
      }
    }
  });

  it('throws on a zero case quantity (never divides by zero)', () => {
    expect(() => quotedPriceCents({ ...stored, unitsPerPack: 0 })).toThrow(
      InvalidPackSizeError,
    );
  });
});
