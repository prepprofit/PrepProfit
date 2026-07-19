import { describe, expect, it } from 'vitest';

import { gtinCheckDigitValid, normalizeBarcode } from './barcode';

describe('normalizeBarcode', () => {
  it('accepts a valid EAN-13 and returns the digits unchanged', () => {
    expect(normalizeBarcode('3017620422003')).toEqual({
      ok: true,
      code: '3017620422003',
    });
  });

  it('accepts a valid EAN-8', () => {
    expect(normalizeBarcode('96385074')).toEqual({ ok: true, code: '96385074' });
  });

  it('accepts a valid UPC-A (12 digits)', () => {
    expect(normalizeBarcode('036000291452')).toEqual({
      ok: true,
      code: '036000291452',
    });
  });

  it('accepts a valid GTIN-14', () => {
    expect(normalizeBarcode('03017620422003')).toEqual({
      ok: true,
      code: '03017620422003',
    });
  });

  it('PRESERVES leading zeroes (never treated as a number)', () => {
    const r = normalizeBarcode('0048151623426');
    expect(r).toEqual({ ok: true, code: '0048151623426' });
    // Guard against any accidental numeric coercion upstream.
    expect(r.ok && r.code.startsWith('00')).toBe(true);
  });

  it('strips accepted separators (spaces, hyphens) before validating', () => {
    expect(normalizeBarcode('  3017620 422003 ')).toEqual({
      ok: true,
      code: '3017620422003',
    });
    expect(normalizeBarcode('3017620-422003')).toEqual({
      ok: true,
      code: '3017620422003',
    });
  });

  it('rejects an invalid check digit', () => {
    expect(normalizeBarcode('3017620422004')).toEqual({
      ok: false,
      reason: 'CHECK_DIGIT',
    });
  });

  it('rejects non-digits after sanitization', () => {
    expect(normalizeBarcode('30176a0422003')).toEqual({
      ok: false,
      reason: 'NON_DIGIT',
    });
  });

  it('rejects an unsupported length', () => {
    expect(normalizeBarcode('12345')).toEqual({ ok: false, reason: 'LENGTH' });
    expect(normalizeBarcode('123456789012345')).toEqual({
      ok: false,
      reason: 'LENGTH',
    });
  });

  it('rejects empty / whitespace-only input', () => {
    expect(normalizeBarcode('')).toEqual({ ok: false, reason: 'EMPTY' });
    expect(normalizeBarcode('   ')).toEqual({ ok: false, reason: 'EMPTY' });
  });
});

describe('gtinCheckDigitValid', () => {
  it('validates each supported GTIN length', () => {
    expect(gtinCheckDigitValid('96385074')).toBe(true); // EAN-8
    expect(gtinCheckDigitValid('036000291452')).toBe(true); // UPC-A
    expect(gtinCheckDigitValid('3017620422003')).toBe(true); // EAN-13
    expect(gtinCheckDigitValid('03017620422003')).toBe(true); // GTIN-14
  });

  it('rejects a wrong check digit', () => {
    expect(gtinCheckDigitValid('3017620422004')).toBe(false);
  });
});
