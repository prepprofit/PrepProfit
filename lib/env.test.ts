import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `serverEnv()` caches at module scope, so each case re-imports a fresh module
 * (vi.resetModules) after setting process.env.
 */
async function loadEnv(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import('./env');
}

const ORIGINAL = { ...process.env };

describe('serverEnv', () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.CRON_SECRET;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it('accepts a valid environment', async () => {
    const { serverEnv } = await loadEnv({
      DATABASE_URL: 'postgres://user:pass@host/db',
      CRON_SECRET: 'a-sufficiently-long-secret',
    });
    expect(serverEnv().DATABASE_URL).toBe('postgres://user:pass@host/db');
    expect(serverEnv().CRON_SECRET).toBe('a-sufficiently-long-secret');
  });

  it('treats CRON_SECRET as optional', async () => {
    const { serverEnv } = await loadEnv({
      DATABASE_URL: 'postgres://user:pass@host/db',
      CRON_SECRET: undefined,
    });
    expect(serverEnv().CRON_SECRET).toBeUndefined();
  });

  it('throws an aggregated error when DATABASE_URL is missing', async () => {
    const { serverEnv } = await loadEnv({ DATABASE_URL: undefined });
    expect(() => serverEnv()).toThrowError(/DATABASE_URL/);
  });

  it('rejects an invalid DATABASE_URL and a too-short CRON_SECRET', async () => {
    const { serverEnv } = await loadEnv({
      DATABASE_URL: 'not-a-url',
      CRON_SECRET: 'short',
    });
    expect(() => serverEnv()).toThrowError(/DATABASE_URL[\s\S]*CRON_SECRET/);
  });

  // Regression: a malformed Resend var must NOT crash the core env. It once made
  // serverEnv() throw for every getDb() caller and 500'd every data page.
  it('ignores a malformed RESEND_FROM_EMAIL (email config is not its concern)', async () => {
    const { serverEnv } = await loadEnv({
      DATABASE_URL: 'postgres://user:pass@host/db',
      RESEND_FROM_EMAIL: 'not-an-email',
      RESEND_API_KEY: 're_whatever',
    });
    expect(() => serverEnv()).not.toThrow();
    expect(serverEnv().DATABASE_URL).toBe('postgres://user:pass@host/db');
  });
});

describe('emailEnv', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it('returns narrowed config and a branded From header when valid', async () => {
    const { emailEnv } = await loadEnv({
      RESEND_API_KEY: 're_live_key',
      RESEND_FROM_EMAIL: 'documents@example.com',
      RESEND_FROM_NAME: undefined,
      RESEND_REPLY_TO: 'hello@example.com',
    });
    expect(emailEnv()).toEqual({
      apiKey: 're_live_key',
      // Defaults the display name to the PrepProfit brand.
      from: 'PrepProfit <documents@example.com>',
      replyTo: 'hello@example.com',
    });
  });

  it('uses RESEND_FROM_NAME as the display name when set', async () => {
    const { emailEnv } = await loadEnv({
      RESEND_API_KEY: 're_live_key',
      RESEND_FROM_EMAIL: 'documents@example.com',
      RESEND_FROM_NAME: 'Acme Kitchen',
    });
    expect(emailEnv().from).toBe('Acme Kitchen <documents@example.com>');
  });

  it('quotes a display name that contains special characters', async () => {
    const { emailEnv } = await loadEnv({
      RESEND_API_KEY: 're_live_key',
      RESEND_FROM_EMAIL: 'documents@example.com',
      RESEND_FROM_NAME: 'PrepProfit, Inc.',
    });
    expect(emailEnv().from).toBe('"PrepProfit, Inc." <documents@example.com>');
  });

  it('treats RESEND_REPLY_TO as optional', async () => {
    const { emailEnv } = await loadEnv({
      RESEND_API_KEY: 're_live_key',
      RESEND_FROM_EMAIL: 'documents@example.com',
      RESEND_REPLY_TO: undefined,
    });
    expect(emailEnv().replyTo).toBeUndefined();
  });

  it('throws when RESEND_FROM_EMAIL is malformed', async () => {
    const { emailEnv } = await loadEnv({
      RESEND_API_KEY: 're_live_key',
      RESEND_FROM_EMAIL: 'not-an-email',
    });
    expect(() => emailEnv()).toThrowError(/RESEND_FROM_EMAIL/);
  });

  it('throws when RESEND_API_KEY is missing', async () => {
    const { emailEnv } = await loadEnv({
      RESEND_API_KEY: undefined,
      RESEND_FROM_EMAIL: 'documents@example.com',
    });
    expect(() => emailEnv()).toThrowError(/RESEND_API_KEY/);
  });

  // The aggregated message must never echo a secret value — only var names.
  it('does not leak the API key value in the error message', async () => {
    const { emailEnv } = await loadEnv({
      RESEND_API_KEY: 're_super_secret_value',
      RESEND_FROM_EMAIL: 'not-an-email',
    });
    expect(() => emailEnv()).not.toThrowError(/re_super_secret_value/);
  });
});

describe('emailAppUrl', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it('returns null when APP_URL is unset (never throws)', async () => {
    const { emailAppUrl } = await loadEnv({ APP_URL: undefined });
    expect(emailAppUrl()).toBeNull();
  });

  it('accepts an https URL and strips a trailing slash', async () => {
    const { emailAppUrl } = await loadEnv({ APP_URL: 'https://app.prepprofit.com/' });
    expect(emailAppUrl()).toBe('https://app.prepprofit.com');
  });

  it('strips multiple trailing slashes', async () => {
    const { emailAppUrl } = await loadEnv({ APP_URL: 'https://app.prepprofit.com///' });
    expect(emailAppUrl()).toBe('https://app.prepprofit.com');
  });

  it('rejects a non-https URL in production', async () => {
    const { emailAppUrl } = await loadEnv({
      APP_URL: 'http://app.prepprofit.com',
      NODE_ENV: 'production',
    });
    expect(emailAppUrl()).toBeNull();
  });

  it('allows http://localhost outside production', async () => {
    const { emailAppUrl } = await loadEnv({
      APP_URL: 'http://localhost:3000',
      NODE_ENV: 'development',
    });
    expect(emailAppUrl()).toBe('http://localhost:3000');
  });

  it('returns null for a malformed value', async () => {
    const { emailAppUrl } = await loadEnv({ APP_URL: 'not a url' });
    expect(emailAppUrl()).toBeNull();
  });
});
