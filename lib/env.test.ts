import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `serverEnv()` caches at module scope, so each case re-imports a fresh module
 * (vi.resetModules) after setting process.env.
 */
async function loadServerEnv(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return (await import('./env')).serverEnv;
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
    const serverEnv = await loadServerEnv({
      DATABASE_URL: 'postgres://user:pass@host/db',
      CRON_SECRET: 'a-sufficiently-long-secret',
    });
    expect(serverEnv().DATABASE_URL).toBe('postgres://user:pass@host/db');
    expect(serverEnv().CRON_SECRET).toBe('a-sufficiently-long-secret');
  });

  it('treats CRON_SECRET as optional', async () => {
    const serverEnv = await loadServerEnv({
      DATABASE_URL: 'postgres://user:pass@host/db',
      CRON_SECRET: undefined,
    });
    expect(serverEnv().CRON_SECRET).toBeUndefined();
  });

  it('throws an aggregated error when DATABASE_URL is missing', async () => {
    const serverEnv = await loadServerEnv({ DATABASE_URL: undefined });
    expect(() => serverEnv()).toThrowError(/DATABASE_URL/);
  });

  it('rejects an invalid DATABASE_URL and a too-short CRON_SECRET', async () => {
    const serverEnv = await loadServerEnv({
      DATABASE_URL: 'not-a-url',
      CRON_SECRET: 'short',
    });
    expect(() => serverEnv()).toThrowError(/DATABASE_URL[\s\S]*CRON_SECRET/);
  });
});
