import { describe, expect, it } from 'vitest';
import { orgSettingsSchema } from './org-settings';

/**
 * Server-side validation of the seller-identity fields added in Sprint 3.5A. The
 * logo URL must be https (it is embedded into the invoice header), email is
 * email-or-blank, and blank text collapses to null.
 */
const base = { currency: 'EUR', measurementSystem: 'metric' };

describe('orgSettingsSchema — business identity', () => {
  it('accepts a fully-filled valid payload', () => {
    const parsed = orgSettingsSchema.parse({
      ...base,
      businessName: '  Padaria  ',
      businessAddress: 'Rua 1',
      businessTaxId: 'PT123',
      businessEmail: 'hi@padaria.pt',
      businessLogoUrl: 'https://cdn.example.com/logo.png',
    });
    expect(parsed.businessName).toBe('Padaria'); // trimmed
    expect(parsed.businessEmail).toBe('hi@padaria.pt');
    expect(parsed.businessLogoUrl).toBe('https://cdn.example.com/logo.png');
  });

  it('defaults missing optional fields to null', () => {
    const parsed = orgSettingsSchema.parse(base);
    expect(parsed.businessName).toBeNull();
    expect(parsed.businessAddress).toBeNull();
    expect(parsed.businessTaxId).toBeNull();
    expect(parsed.businessEmail).toBeNull();
    expect(parsed.businessLogoUrl).toBeNull();
  });

  it('collapses blank strings to null', () => {
    const parsed = orgSettingsSchema.parse({
      ...base,
      businessName: '   ',
      businessEmail: '',
      businessLogoUrl: '',
    });
    expect(parsed.businessName).toBeNull();
    expect(parsed.businessEmail).toBeNull();
    expect(parsed.businessLogoUrl).toBeNull();
  });

  it('rejects a non-https logo URL', () => {
    for (const url of [
      'http://cdn.example.com/logo.png',
      'data:image/png;base64,AAAA',
      'javascript:alert(1)',
      'ftp://example.com/logo.png',
      'not a url',
    ]) {
      const result = orgSettingsSchema.safeParse({ ...base, businessLogoUrl: url });
      expect(result.success, url).toBe(false);
    }
  });

  it('rejects an invalid email and over-long text', () => {
    expect(
      orgSettingsSchema.safeParse({ ...base, businessEmail: 'not-an-email' }).success,
    ).toBe(false);
    expect(
      orgSettingsSchema.safeParse({ ...base, businessName: 'a'.repeat(121) }).success,
    ).toBe(false);
    expect(
      orgSettingsSchema.safeParse({ ...base, businessAddress: 'a'.repeat(401) })
        .success,
    ).toBe(false);
  });
});

/**
 * Sprint F5 — fiscal fields. The tax rate is entered as a percentage (0..100) and
 * stored as integer basis points (0..10000); empty → null ("not configured"). The
 * stock-control date is a real calendar date or null.
 */
describe('orgSettingsSchema — fiscal config (F5)', () => {
  const parse = (overrides: Record<string, unknown>) =>
    orgSettingsSchema.safeParse({ ...base, ...overrides });

  it('converts whole and decimal percents to basis points', () => {
    const whole = parse({ defaultTaxRateBps: '23' });
    expect(whole.success && whole.data.defaultTaxRateBps).toBe(2300);
    const dec = parse({ defaultTaxRateBps: '8.5' });
    expect(dec.success && dec.data.defaultTaxRateBps).toBe(850);
  });

  it('accepts the 0 and 100 bounds', () => {
    const zero = parse({ defaultTaxRateBps: '0' });
    expect(zero.success && zero.data.defaultTaxRateBps).toBe(0);
    const max = parse({ defaultTaxRateBps: '100' });
    expect(max.success && max.data.defaultTaxRateBps).toBe(10000);
  });

  it('treats empty / missing tax rate as null', () => {
    const empty = parse({ defaultTaxRateBps: '' });
    expect(empty.success && empty.data.defaultTaxRateBps).toBeNull();
    const missing = parse({});
    expect(missing.success && missing.data.defaultTaxRateBps).toBeNull();
  });

  it('rejects over-100 and negative percents', () => {
    expect(parse({ defaultTaxRateBps: '101' }).success).toBe(false);
    expect(parse({ defaultTaxRateBps: '-1' }).success).toBe(false);
  });

  it('accepts a real calendar start date, blank → null', () => {
    const ok = parse({ stockControlStartDate: '2026-06-01' });
    expect(ok.success && ok.data.stockControlStartDate).toBe('2026-06-01');
    const blank = parse({ stockControlStartDate: '' });
    expect(blank.success && blank.data.stockControlStartDate).toBeNull();
  });

  it('rejects an impossible start date', () => {
    expect(parse({ stockControlStartDate: '2026-02-30' }).success).toBe(false);
    expect(parse({ stockControlStartDate: 'nope' }).success).toBe(false);
  });
});
