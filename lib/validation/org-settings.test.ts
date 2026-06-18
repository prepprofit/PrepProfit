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
