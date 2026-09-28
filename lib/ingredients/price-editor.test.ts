import { describe, expect, it } from 'vitest';
import {
  EMPTY_PRICE_STATE,
  applyVatRate,
  editPrice,
  initPriceState,
  linkedPrices,
  setPriceBasis,
  type PriceEditState,
} from '@/lib/ingredients/price-editor';

const kg5 = { unitsPerPack: 1, packSize: 5, packUnit: 'kg' as const };

const ok = (r: ReturnType<typeof setPriceBasis>): PriceEditState => {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.state;
};

describe('linked pack ↔ unit fields', () => {
  it('pack size + pack price calculates the price per kg', () => {
    const s = editPrice(EMPTY_PRICE_STATE, 'pack', '50', null);
    expect(linkedPrices(s, kg5, 'weight', null)).toMatchObject({ packText: '50', unitText: '10.00', source: 'pack' });
  });

  it('pack size + price per kg calculates the pack price; the last edited field is the source', () => {
    const s = editPrice(editPrice(EMPTY_PRICE_STATE, 'pack', '50', null), 'unit', '12', null);
    expect(linkedPrices(s, kg5, 'weight', null)).toMatchObject({ unitText: '12', packText: '60.00', source: 'unit' });
  });

  it('accepts decimal commas and points', () => {
    for (const text of ['9,90', '9.90']) {
      const s = editPrice(EMPTY_PRICE_STATE, 'unit', text, null);
      expect(linkedPrices(s, kg5, 'weight', null).packText).toBe('49.50');
    }
  });

  it('recalculates when the pack changes without touching the typed price', () => {
    const s = editPrice(EMPTY_PRICE_STATE, 'pack', '50', null);
    expect(linkedPrices(s, { ...kg5, packSize: 10 }, 'weight', null).unitText).toBe('5.00');
  });

  it('multipack total is units × size', () => {
    const s = editPrice(EMPTY_PRICE_STATE, 'pack', '66', null);
    expect(linkedPrices(s, { unitsPerPack: 4, packSize: 1.65, packUnit: 'kg' }, 'weight', null).unitText).toBe('10.00');
  });

  it('leaves the other field blank, with the reason, when the pack is missing or unconvertible', () => {
    const s = editPrice(EMPTY_PRICE_STATE, 'unit', '10', null);
    expect(linkedPrices(s, null, 'weight', null)).toMatchObject({ packText: '', unitText: '10', packIssue: 'incomplete' });
    expect(linkedPrices(s, { unitsPerPack: 1, packSize: 500, packUnit: 'ml' }, 'weight', null)).toMatchObject({
      packText: '',
      packIssue: 'needs_equivalency',
    });
  });

  it('a blank or invalid source field shows nothing calculated', () => {
    expect(linkedPrices(EMPTY_PRICE_STATE, kg5, 'weight', null).unitText).toBe('');
    expect(linkedPrices(editPrice(EMPTY_PRICE_STATE, 'pack', '5x', null), kg5, 'weight', null).unitText).toBe('');
  });

  it('opens an existing unit price into the calculator on the chosen basis', () => {
    const s = initPriceState({ source: 'unit', netCents: 1000, includesVat: false, vatBps: null });
    expect(linkedPrices(s, kg5, 'weight', null)).toMatchObject({ unitText: '10.00', packText: '50.00' });
  });
});

describe('prices entered: excl. / incl. VAT', () => {
  it('switching to incl. converts the amount and preserves the net (excl. €50 → incl. €60 at 20%)', () => {
    const s = editPrice(EMPTY_PRICE_STATE, 'pack', '50', 2000);
    const incl = ok(setPriceBasis(s, true, 2000));
    expect(incl).toMatchObject({ text: '60.00', includesVat: true, netCents: 5000 });
    expect(linkedPrices(incl, kg5, 'weight', null).unitText).toBe('12.00');
    const back = ok(setPriceBasis(incl, false, 2000));
    expect(back).toMatchObject({ text: '50.00', includesVat: false, netCents: 5000 });
  });

  it('typing an incl. price nets it once (€60 incl. 20% → €50 net)', () => {
    const s = { ...EMPTY_PRICE_STATE, includesVat: true };
    expect(editPrice(s, 'pack', '60', 2000).netCents).toBeCloseTo(5000, 6);
  });

  it('round-trips without drift even when the net is not a whole number of cents', () => {
    let s = editPrice(EMPTY_PRICE_STATE, 'unit', '8.33', 1400);
    for (let i = 0; i < 6; i++) {
      s = ok(setPriceBasis(s, true, 1400));
      s = ok(setPriceBasis(s, false, 1400));
    }
    expect(s.text).toBe('8.33');
  });

  it('going incl. with no VAT rate keeps the net, blanks the figure, and fills it once a rate is typed', () => {
    const s = editPrice(EMPTY_PRICE_STATE, 'pack', '50', null);
    const incl = ok(setPriceBasis(s, true, null));
    expect(incl).toMatchObject({ text: '', textStale: true, netCents: 5000 });
    expect(applyVatRate(incl, 2000)).toMatchObject({ text: '60.00', textStale: false, netCents: 5000 });
  });

  it('never relabels: a typed incl. price with no rate cannot be flipped to excl.', () => {
    const s = editPrice({ ...EMPTY_PRICE_STATE, includesVat: true }, 'pack', '60', null);
    expect(setPriceBasis(s, false, null)).toEqual({ ok: false, reason: 'vat_rate_required' });
  });

  it('correcting the VAT rate re-nets the typed gross price', () => {
    const s = editPrice({ ...EMPTY_PRICE_STATE, includesVat: true }, 'pack', '60', 2000);
    expect(applyVatRate(s, 1400).netCents).toBeCloseTo(60_00 / 1.14, 6);
  });

  it('an empty field switches basis freely', () => {
    expect(ok(setPriceBasis({ ...EMPTY_PRICE_STATE, includesVat: true }, false, null)).includesVat).toBe(false);
  });

  it('initialises an existing net price as incl. VAT only with a known rate', () => {
    expect(initPriceState({ source: 'pack', netCents: 5000, includesVat: true, vatBps: 2000 }).text).toBe('60.00');
    expect(initPriceState({ source: 'pack', netCents: 5000, includesVat: true, vatBps: null })).toMatchObject({ text: '', textStale: true });
  });
});
