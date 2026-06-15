import { describe, expect, it } from 'vitest';
import { isCronAuthorized } from '@/lib/cron-auth';

describe('isCronAuthorized', () => {
  const secret = 'super-secret-value';

  it('accepts the matching bearer token', () => {
    expect(isCronAuthorized(`Bearer ${secret}`, secret)).toBe(true);
  });

  it('rejects a wrong token', () => {
    expect(isCronAuthorized('Bearer nope', secret)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(isCronAuthorized(null, secret)).toBe(false);
  });

  it('rejects when no secret is configured (secure by default)', () => {
    expect(isCronAuthorized(`Bearer ${secret}`, undefined)).toBe(false);
    expect(isCronAuthorized(`Bearer ${secret}`, '')).toBe(false);
  });

  it('rejects a header missing the Bearer prefix', () => {
    expect(isCronAuthorized(secret, secret)).toBe(false);
  });
});
