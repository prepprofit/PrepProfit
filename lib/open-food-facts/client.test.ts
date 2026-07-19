import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { lookupOffProduct } from './client';
import solidFixture from './__fixtures__/solid-food-100g.json';
import notFoundFixture from './__fixtures__/not-found.json';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('OPEN_FOOD_FACTS_ENABLED', 'true');
  vi.stubEnv('OPEN_FOOD_FACTS_USER_AGENT', 'PrepProfit/1.0 (test@prepprofit.com)');
  vi.stubEnv('OPEN_FOOD_FACTS_BASE_URL', 'https://off.test');
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('lookupOffProduct', () => {
  it('returns DISABLED when the feature flag is off (no fetch)', async () => {
    vi.stubEnv('OPEN_FOOD_FACTS_ENABLED', 'false');
    const r = await lookupOffProduct('3017620422003');
    expect(r).toEqual({ ok: false, reason: 'DISABLED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses a found product and sends UA + Accept to the v3 endpoint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(solidFixture));
    const r = await lookupOffProduct('3017620422003');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.product.product_name).toBe('Nutella');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/api/v3/product/3017620422003');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('PrepProfit/');
    expect(headers.Accept).toBe('application/json');
  });

  it('maps a v3 "failure" body to NOT_FOUND', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(notFoundFixture));
    const r = await lookupOffProduct('0000000000000');
    expect(r).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('maps HTTP 404 to NOT_FOUND without retrying', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 404));
    const r = await lookupOffProduct('3017620422003');
    expect(r).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps HTTP 429 to RATE_LIMITED without retrying', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 429));
    const r = await lookupOffProduct('3017620422003');
    expect(r).toEqual({ ok: false, reason: 'RATE_LIMITED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries once on a 5xx, then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse(solidFixture));
    const r = await lookupOffProduct('3017620422003');
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns UNAVAILABLE after two 5xx responses', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));
    const r = await lookupOffProduct('3017620422003');
    expect(r).toEqual({ ok: false, reason: 'UNAVAILABLE' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns UNAVAILABLE on repeated network errors', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const r = await lookupOffProduct('3017620422003');
    expect(r).toEqual({ ok: false, reason: 'UNAVAILABLE' });
  });

  it('returns INVALID_RESPONSE for a structurally broken payload', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ product: 'not-an-object' }));
    const r = await lookupOffProduct('3017620422003');
    expect(r).toEqual({ ok: false, reason: 'INVALID_RESPONSE' });
  });

  it('never leaks the user agent into the returned result', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(solidFixture));
    const r = await lookupOffProduct('3017620422003');
    expect(JSON.stringify(r)).not.toContain('test@prepprofit.com');
  });
});
