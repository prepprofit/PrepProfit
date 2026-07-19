import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';

import { createTestDb } from './helpers/db';
import * as schema from '@/lib/db/schema';
import { externalFoodCache } from '@/lib/db/schema';
import {
  resolveOffByBarcode,
  resetOffResolverState,
} from '@/lib/open-food-facts/resolve';
import { putCachedFood } from '@/lib/data/external-food-cache';
import { normalizeOffProduct } from '@/lib/open-food-facts/normalize';
import { offResponseSchema } from '@/lib/open-food-facts/schemas';

import solidFixture from '@/lib/open-food-facts/__fixtures__/solid-food-100g.json';
import nonFoodFixture from '@/lib/open-food-facts/__fixtures__/non-food.json';

/**
 * Resolver + persistent cache + circuit breaker (OFF integration plan §13):
 * cache fresh/miss/stale-on-error, breaker transitions, 404 never opening the
 * breaker, and rejected products never cached. Uses a real PGlite cache table +
 * a mocked provider — never the live API.
 */

const BARCODE = '3017620422003';

let client: PGlite;
let db: NeonDatabase<typeof schema>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn<typeof fetch>();

/** Build the snapshot the resolver would store, for direct cache seeding. */
function solidSnapshot() {
  const product = offResponseSchema.parse(solidFixture).product!;
  const r = normalizeOffProduct(product, BARCODE);
  if (!r.ok) throw new Error('fixture should normalize');
  return r.snapshot;
}

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as NeonDatabase<typeof schema>;
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('OPEN_FOOD_FACTS_ENABLED', 'true');
  vi.stubEnv('OPEN_FOOD_FACTS_USER_AGENT', 'PrepProfit/1.0 (test@prepprofit.com)');
  vi.stubEnv('OPEN_FOOD_FACTS_BASE_URL', 'https://off.test');
  fetchMock.mockReset();
  resetOffResolverState();
  await db.delete(externalFoodCache);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('resolveOffByBarcode', () => {
  it('returns DISABLED without hitting the provider when the flag is off', async () => {
    vi.stubEnv('OPEN_FOOD_FACTS_ENABLED', 'false');
    const r = await resolveOffByBarcode(db, BARCODE);
    expect(r).toEqual({ ok: false, reason: 'DISABLED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('miss → provider → caches; second call is served fresh (no fetch)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(solidFixture));
    const first = await resolveOffByBarcode(db, BARCODE);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.stale).toBe(false);

    const second = await resolveOffByBarcode(db, BARCODE);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.stale).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1); // second served from cache
  });

  it('forceRefresh bypasses the fresh cache and re-fetches', async () => {
    // A fresh Response per call — a Response body can only be read once.
    fetchMock.mockImplementation(async () => jsonResponse(solidFixture));
    await resolveOffByBarcode(db, BARCODE);
    await resolveOffByBarcode(db, BARCODE, { forceRefresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serves a STALE entry when the provider is unavailable', async () => {
    // Seed a cache row, then age it into the stale window.
    await putCachedFood(db, solidSnapshot(), new Date());
    const past = new Date(Date.now() - 48 * 60 * 60 * 1000); // 2 days ago
    await db
      .update(externalFoodCache)
      .set({ fetchedAt: past, expiresAt: past })
      .where(eq(externalFoodCache.externalId, BARCODE));

    fetchMock.mockResolvedValue(jsonResponse({}, 500));
    const r = await resolveOffByBarcode(db, BARCODE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stale).toBe(true);
      expect(r.snapshot.nutrients.caloriesKcal).toBe(539);
    }
  });

  it('opens the breaker after 5 consecutive failures, then short-circuits', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));
    for (let i = 0; i < 5; i += 1) {
      const r = await resolveOffByBarcode(db, `501011256789${i}`);
      expect(r.ok).toBe(false);
    }
    // Each failed resolve = 2 fetches (one retry) = 10 total.
    expect(fetchMock).toHaveBeenCalledTimes(10);

    const afterOpen = await resolveOffByBarcode(db, BARCODE);
    expect(afterOpen).toEqual({ ok: false, reason: 'UNAVAILABLE' });
    expect(fetchMock).toHaveBeenCalledTimes(10); // breaker open → no new fetch
  });

  it('a 404 never opens the breaker', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 404));
    for (let i = 0; i < 8; i += 1) {
      const r = await resolveOffByBarcode(db, `501011256789${i}`);
      expect(r).toEqual({ ok: false, reason: 'NOT_FOUND' });
    }
    // Breaker still closed → a subsequent good lookup succeeds.
    fetchMock.mockResolvedValueOnce(jsonResponse(solidFixture));
    const ok = await resolveOffByBarcode(db, BARCODE);
    expect(ok.ok).toBe(true);
  });

  it('a rejected (non-food) product is NOT cached', async () => {
    fetchMock.mockResolvedValue(jsonResponse(nonFoodFixture));
    const r = await resolveOffByBarcode(db, '3600542525732');
    expect(r).toEqual({ ok: false, reason: 'NON_FOOD' });

    const rows = await db
      .select()
      .from(externalFoodCache)
      .where(eq(externalFoodCache.externalId, '3600542525732'));
    expect(rows).toHaveLength(0);
  });
});
