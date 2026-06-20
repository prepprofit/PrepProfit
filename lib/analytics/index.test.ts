import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Product analytics seam (Sprint 5c). Proves it is FAIL-OPEN and PII-safe:
 *  - configured → POSTs the named event to PostHog with the org as a group, the
 *    user as distinct id, and only the given (primitive) properties.
 *  - unconfigured → no-op, never calls fetch.
 *  - a fetch failure is swallowed by `trackEvent` (never throws).
 * `fetch` is stubbed; nothing leaves the process.
 */

const ORIGINAL = { ...process.env };

function loadFresh() {
  // Re-import after mutating env so the lazy `analyticsEnv()` re-reads it.
  vi.resetModules();
  return import('./index');
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('getAnalytics (configured)', () => {
  it('posts the event with org group + given properties', async () => {
    process.env.POSTHOG_KEY = 'phc_test';
    delete process.env.POSTHOG_HOST;
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(null, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { getAnalytics } = await loadFresh();
    await getAnalytics().capture({
      event: 'recipe_created',
      orgId: 'org_a',
      userId: 'user_1',
      properties: { hasFolder: true },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('https://us.i.posthog.com/capture/');
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({
      api_key: 'phc_test',
      event: 'recipe_created',
      distinct_id: 'user_1',
      properties: { hasFolder: true, $groups: { organization: 'org_a' } },
    });
  });

  it('falls back to an org distinct id when no user', async () => {
    process.env.POSTHOG_KEY = 'phc_test';
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(null, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { getAnalytics } = await loadFresh();
    await getAnalytics().capture({ event: 'invoice_issued', orgId: 'org_a' });
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.distinct_id).toBe('org:org_a');
  });
});

describe('getAnalytics (unconfigured)', () => {
  it('is a no-op and never calls fetch', async () => {
    delete process.env.POSTHOG_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { getAnalytics } = await loadFresh();
    await getAnalytics().capture({ event: 'recipe_created', orgId: 'org_a' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('trackEvent', () => {
  it('swallows a fetch failure (fail-open)', async () => {
    process.env.POSTHOG_KEY = 'phc_test';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    const { trackEvent } = await loadFresh();
    await expect(
      trackEvent({ event: 'recipe_created', orgId: 'org_a' }),
    ).resolves.toBeUndefined();
  });
});
