import { describe, expect, it } from 'vitest';
import { packCanonicalQuantity, resolveEnteredPrice } from '@/lib/calculations/ingredientPriceEntry';

const kg5 = { unitsPerPack: 1, packSize: 5, packUnit: 'kg' as const };

describe('resolveEnteredPrice', () => {
  it('pack €50 for 5 kg → €10/kg', () => {
    expect(resolveEnteredPrice({ source: 'pack', amountCents: 5000, includesVat: false, vatRateBps: null, pack: kg5, dimension: 'weight' })).toEqual({
      ok: true,
      value: { netUnitCents: 1000, netPackCents: 5000, packIssue: null },
    });
  });

  it('unit €10/kg with 5 kg → €50 pack', () => {
    expect(resolveEnteredPrice({ source: 'unit', amountCents: 1000, includesVat: false, vatRateBps: null, pack: kg5, dimension: 'weight' })).toEqual({
      ok: true,
      value: { netUnitCents: 1000, netPackCents: 5000, packIssue: null },
    });
  });

  it('a typed price per kg needs no pack at all', () => {
    expect(resolveEnteredPrice({ source: 'unit', amountCents: 1000, includesVat: false, vatRateBps: null, pack: null, dimension: 'weight' })).toEqual({
      ok: true,
      value: { netUnitCents: 1000, netPackCents: null, packIssue: 'incomplete' },
    });
  });

  it('a typed pack price without a pack cannot be turned into a cost', () => {
    expect(resolveEnteredPrice({ source: 'pack', amountCents: 5000, includesVat: false, vatRateBps: null, pack: null, dimension: 'weight' })).toEqual({
      ok: false,
      reason: 'pack_required',
    });
  });

  it('€60 including 20% VAT for 5 kg → €10/kg and €50 net pack', () => {
    const r = resolveEnteredPrice({ source: 'pack', amountCents: 6000, includesVat: true, vatRateBps: 2000, pack: kg5, dimension: 'weight' });
    expect(r).toEqual({ ok: true, value: { netUnitCents: 1000, netPackCents: 5000, packIssue: null } });
  });

  it('removes VAT from a typed unit price too (€12/kg incl. 20% → €10/kg)', () => {
    const r = resolveEnteredPrice({ source: 'unit', amountCents: 1200, includesVat: true, vatRateBps: 2000, pack: null, dimension: 'weight' });
    expect(r).toMatchObject({ ok: true, value: { netUnitCents: 1000 } });
  });

  it('never assumes 0% VAT: including-VAT with no rate fails, an explicit 0% is a rate', () => {
    expect(resolveEnteredPrice({ source: 'unit', amountCents: 1200, includesVat: true, vatRateBps: null, pack: null, dimension: 'weight' })).toEqual({
      ok: false,
      reason: 'vat_rate_required',
    });
    expect(resolveEnteredPrice({ source: 'unit', amountCents: 1200, includesVat: true, vatRateBps: 0, pack: null, dimension: 'weight' })).toMatchObject({
      ok: true,
      value: { netUnitCents: 1200 },
    });
  });

  it('multipack: 4 × 1.65 kg for €66 → €10/kg', () => {
    const r = resolveEnteredPrice({
      source: 'pack',
      amountCents: 6600,
      includesVat: false,
      vatRateBps: null,
      pack: { unitsPerPack: 4, packSize: 1.65, packUnit: 'kg' },
      dimension: 'weight',
    });
    expect(r).toMatchObject({ ok: true, value: { netUnitCents: 1000, netPackCents: 6600 } });
  });

  it('grams convert: 500 g for €4 → €8/kg; €8/kg over 500 g → €4', () => {
    const pack = { unitsPerPack: 1, packSize: 500, packUnit: 'g' as const };
    expect(resolveEnteredPrice({ source: 'pack', amountCents: 400, includesVat: false, vatRateBps: null, pack, dimension: 'weight' })).toMatchObject({
      value: { netUnitCents: 800 },
    });
    expect(resolveEnteredPrice({ source: 'unit', amountCents: 800, includesVat: false, vatRateBps: null, pack, dimension: 'weight' })).toMatchObject({
      value: { netPackCents: 400 },
    });
  });

  it('litres and millilitres convert for a volume ingredient', () => {
    const r = resolveEnteredPrice({
      source: 'pack',
      amountCents: 350,
      includesVat: false,
      vatRateBps: null,
      pack: { unitsPerPack: 1, packSize: 500, packUnit: 'ml' },
      dimension: 'volume',
    });
    expect(r).toMatchObject({ ok: true, value: { netUnitCents: 700 } }); // €7.00 per litre
  });

  it('500 ml on a weight ingredient is not 500 g without an equivalency', () => {
    const pack = { unitsPerPack: 1, packSize: 500, packUnit: 'ml' as const };
    expect(resolveEnteredPrice({ source: 'pack', amountCents: 450, includesVat: false, vatRateBps: null, pack, dimension: 'weight' })).toEqual({
      ok: false,
      reason: 'needs_equivalency',
    });
    // A typed price per kg still works; the pack just can't be priced.
    expect(resolveEnteredPrice({ source: 'unit', amountCents: 900, includesVat: false, vatRateBps: null, pack, dimension: 'weight' })).toEqual({
      ok: true,
      value: { netUnitCents: 900, netPackCents: null, packIssue: 'needs_equivalency' },
    });
  });

  it('a real equivalency (500 ml = 700 g) makes the same pack convertible', () => {
    const r = resolveEnteredPrice({
      source: 'pack',
      amountCents: 700,
      includesVat: false,
      vatRateBps: null,
      pack: { unitsPerPack: 1, packSize: 500, packUnit: 'ml' },
      dimension: 'weight',
      anchors: { weightGrams: 700, volumeMl: 500, eachCount: null },
    });
    expect(r).toMatchObject({ ok: true, value: { netUnitCents: 1000 } });
  });

  it('zero is a deliberate price; NaN, Infinity and negatives are invalid', () => {
    expect(resolveEnteredPrice({ source: 'unit', amountCents: 0, includesVat: false, vatRateBps: null, pack: null, dimension: 'weight' })).toMatchObject({
      ok: true,
      value: { netUnitCents: 0 },
    });
    for (const amountCents of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(resolveEnteredPrice({ source: 'unit', amountCents, includesVat: false, vatRateBps: null, pack: null, dimension: 'weight' })).toEqual({
        ok: false,
        reason: 'invalid_amount',
      });
    }
  });

  it('large values stay exact integer cents', () => {
    const r = resolveEnteredPrice({
      source: 'pack',
      amountCents: 99_999_999,
      includesVat: false,
      vatRateBps: null,
      pack: { unitsPerPack: 1, packSize: 1000, packUnit: 'kg' },
      dimension: 'weight',
    });
    expect(r).toMatchObject({ ok: true, value: { netUnitCents: 100_000 } });
  });
});

describe('packCanonicalQuantity', () => {
  it('flags incomplete packs and non-positive sizes', () => {
    expect(packCanonicalQuantity(null, 'weight', null)).toEqual({ ok: false, reason: 'incomplete' });
    expect(packCanonicalQuantity({ unitsPerPack: 1, packSize: 0, packUnit: 'kg' }, 'weight', null)).toEqual({ ok: false, reason: 'incomplete' });
    expect(packCanonicalQuantity({ unitsPerPack: 0, packSize: 1, packUnit: 'kg' }, 'weight', null)).toEqual({ ok: false, reason: 'incomplete' });
  });
});
