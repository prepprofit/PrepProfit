import { describe, expect, it } from 'vitest';
import {
  isPackBlockingSave,
  isPackStarted,
  validateSupplierPackForm,
  type SupplierPackFormValues,
} from '@/lib/validation/supplier-pack-form';

/**
 * The rule that stands between a manager and a dead-end Save button
 * (decision D1, `docs/supplier-dialog-ux-plan.md`). Two properties matter most:
 * a name-only supplier still saves, and a HALF-described pack never reaches the
 * server as a silently-dropped field.
 */

/** A dialog freshly opened on an ingredient with no link: unit pre-filled, packs = 1. */
const fresh = (over: Partial<SupplierPackFormValues> = {}): SupplierPackFormValues => ({
  supplierName: '',
  unitsPerPack: '1',
  packSize: '',
  packUnit: 'kg',
  packPrice: '',
  ...over,
});

describe('isPackStarted', () => {
  it('is false on an untouched form even though the unit select is pre-filled', () => {
    expect(isPackStarted(fresh())).toBe(false);
  });

  it('is false for a unit alone — the pre-filled select must never be the trigger', () => {
    expect(isPackStarted(fresh({ packUnit: 'l' }))).toBe(false);
  });

  it('is true once a size or a price is typed', () => {
    expect(isPackStarted(fresh({ packSize: '5' }))).toBe(true);
    expect(isPackStarted(fresh({ packPrice: '12.50' }))).toBe(true);
  });
});

describe('validateSupplierPackForm — the name-only flow', () => {
  it('reports only the missing name on an untouched form', () => {
    expect(validateSupplierPackForm(fresh())).toEqual({
      supplierName: 'supplierRequired',
    });
  });

  it('accepts a supplier name with no pack at all', () => {
    expect(validateSupplierPackForm(fresh({ supplierName: 'Metro' }))).toEqual({});
  });

  it('treats a whitespace-only name as missing', () => {
    expect(validateSupplierPackForm(fresh({ supplierName: '   ' }))).toEqual({
      supplierName: 'supplierRequired',
    });
  });

  it('never blocks Save on a name-only form — the button stays clickable', () => {
    expect(isPackBlockingSave(validateSupplierPackForm(fresh()))).toBe(false);
  });
});

describe('validateSupplierPackForm — the pack trio travels together', () => {
  it('demands a price once a size is typed', () => {
    expect(
      validateSupplierPackForm(fresh({ supplierName: 'Metro', packSize: '1.65' })),
    ).toEqual({ packPrice: 'priceRequired' });
  });

  it('demands a size once a price is typed', () => {
    expect(
      validateSupplierPackForm(fresh({ supplierName: 'Metro', packPrice: '24.90' })),
    ).toEqual({ packSize: 'packSizeRequired' });
  });

  it('demands a unit when the select was cleared to "—"', () => {
    expect(
      validateSupplierPackForm(
        fresh({ supplierName: 'Metro', packSize: '1.65', packUnit: '', packPrice: '24.90' }),
      ),
    ).toEqual({ packUnit: 'packUnitRequired' });
  });

  it('passes on a complete pack', () => {
    expect(
      validateSupplierPackForm(
        fresh({
          supplierName: 'Metro',
          unitsPerPack: '4',
          packSize: '1.65',
          packUnit: 'kg',
          packPrice: '24.90',
        }),
      ),
    ).toEqual({});
  });

  it('blocks Save while the pack is half-filled, and releases it when complete', () => {
    const half = validateSupplierPackForm(fresh({ supplierName: 'Metro', packSize: '5' }));
    expect(isPackBlockingSave(half)).toBe(true);

    const whole = validateSupplierPackForm(
      fresh({ supplierName: 'Metro', packSize: '5', packPrice: '10' }),
    );
    expect(isPackBlockingSave(whole)).toBe(false);
  });

  it('blocks Save on a half-filled pack even before a supplier is picked', () => {
    const errors = validateSupplierPackForm(fresh({ packSize: '5' }));
    expect(errors.supplierName).toBe('supplierRequired');
    expect(isPackBlockingSave(errors)).toBe(true);
  });
});

describe('validateSupplierPackForm — values the dialog would silently drop', () => {
  const base = { supplierName: 'Metro', packPrice: '24.90' };

  it.each(['0', '-1', 'abc'])('rejects pack size %s', (packSize) => {
    expect(validateSupplierPackForm(fresh({ ...base, packSize })).packSize).toBe(
      'packSizeInvalid',
    );
  });

  it('rejects a comma decimal, because the payload parses with Number()', () => {
    // `Number('1,65')` is NaN, so the dialog would omit packSize entirely and the
    // manager would lose the pack without being told. Fail loudly instead.
    expect(validateSupplierPackForm(fresh({ ...base, packSize: '1,65' })).packSize).toBe(
      'packSizeInvalid',
    );
  });

  it.each(['0', '0.00', 'free'])('rejects price %s', (packPrice) => {
    expect(
      validateSupplierPackForm(fresh({ supplierName: 'Metro', packSize: '5', packPrice }))
        .packPrice,
    ).toBe('priceInvalid');
  });

  it.each(['', '0', '1.5', '-2'])('rejects pack count %s', (unitsPerPack) => {
    expect(
      validateSupplierPackForm(
        fresh({ ...base, packSize: '1.65', unitsPerPack }),
      ).unitsPerPack,
    ).toBe('unitsInvalid');
  });

  it('ignores a bad pack count while no pack is described', () => {
    // Nothing is sent for an untouched pack, so there is nothing to complain about.
    expect(
      validateSupplierPackForm(fresh({ supplierName: 'Metro', unitsPerPack: '' })),
    ).toEqual({});
  });
});
