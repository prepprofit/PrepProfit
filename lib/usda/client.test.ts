import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearUsdaCache, getUsdaFood, searchUsdaFoods } from './client';

/** Minimal abridged nutrient entry as FDC search returns it. */
function nutrient(nutrientNumber: string, unitName: string, value: number) {
  return { nutrientNumber, unitName, value };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('USDA_FDC_API_KEY', 'test-key');
  fetchMock.mockReset();
  clearUsdaCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('searchUsdaFoods', () => {
  it('returns NOT_CONFIGURED without the env var (D1: custom-only mode)', async () => {
    vi.stubEnv('USDA_FDC_API_KEY', '');
    const r = await searchUsdaFoods('flour', 'common');
    expect(r).toEqual({ ok: false, reason: 'NOT_CONFIGURED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes known nutrients and keeps missing ones null (never 0)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        totalHits: 1,
        foods: [
          {
            fdcId: 123,
            description: 'Wheat flour',
            dataType: 'Foundation',
            foodNutrients: [
              nutrient('208', 'KCAL', 364),
              nutrient('203', 'G', 10.3),
              nutrient('9999', 'G', 5), // unknown number → ignored
            ],
          },
        ],
      }),
    );
    const r = await searchUsdaFoods('flour', 'common');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(1);
    const food = r.value[0]!;
    expect(food.fdcId).toBe(123);
    expect(food.nutrientsPer100g.caloriesKcal).toBe(364);
    expect(food.nutrientsPer100g.proteinG).toBe(10.3);
    expect(food.nutrientsPer100g.sodiumMg).toBeNull();
  });

  it('drops values with unexpected units or invalid numbers', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        foods: [
          {
            fdcId: 1,
            description: 'X',
            foodNutrients: [
              nutrient('208', 'kJ', 1523), // wrong unit → null
              nutrient('307', 'MG', -4), // negative → null
              nutrient('301', 'MG', Number.NaN), // non-finite → null (also fails Zod? number allows NaN)
              nutrient('303', 'MG', 1.2),
            ],
          },
        ],
      }),
    );
    const r = await searchUsdaFoods('x', 'branded');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const n = r.value[0]!.nutrientsPer100g;
    expect(n.caloriesKcal).toBeNull();
    expect(n.sodiumMg).toBeNull();
    expect(n.calciumMg).toBeNull();
    expect(n.ironMg).toBe(1.2);
  });

  it('sends the scope as FDC dataType and never caches across scopes', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ foods: [] }));
    await searchUsdaFoods('milk', 'common');
    await searchUsdaFoods('milk', 'branded');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = String(fetchMock.mock.calls[0]![0]);
    const second = String(fetchMock.mock.calls[1]![0]);
    expect(first).toContain('Foundation');
    expect(first).toContain('SR+Legacy');
    expect(second).toContain('Branded');
  });

  it('caches an identical query (second call = no fetch)', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ foods: [] }));
    await searchUsdaFoods('milk', 'common');
    await searchUsdaFoods('milk', 'common');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never leaks the API key into results or errors', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ foods: [] }));
    const r = await searchUsdaFoods('milk', 'common');
    expect(JSON.stringify(r)).not.toContain('test-key');
  });

  it('retries once on a 5xx, then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({ foods: [] }));
    const r = await searchUsdaFoods('milk', 'common');
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns UNAVAILABLE after two 5xx responses', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}, 503));
    const r = await searchUsdaFoods('milk', 'common');
    expect(r).toEqual({ ok: false, reason: 'UNAVAILABLE' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns UNAVAILABLE on repeated network errors', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const r = await searchUsdaFoods('milk', 'common');
    expect(r).toEqual({ ok: false, reason: 'UNAVAILABLE' });
  });

  it('returns INVALID_RESPONSE for a malformed payload', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ foods: [{ bogus: true }] }));
    const r = await searchUsdaFoods('milk', 'common');
    expect(r).toEqual({ ok: false, reason: 'INVALID_RESPONSE' });
  });
});

describe('getUsdaFood', () => {
  it('parses an abridged detail (number/amount shape)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        fdcId: 456,
        description: 'Whole milk',
        dataType: 'Branded',
        brandOwner: 'Acme Dairy',
        foodNutrients: [
          { number: '208', unitName: 'KCAL', amount: 61 },
          { number: '301', unitName: 'MG', amount: 113 },
        ],
      }),
    );
    const r = await getUsdaFood(456);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.brandOwner).toBe('Acme Dairy');
    expect(r.value.nutrientsPer100g.caloriesKcal).toBe(61);
    expect(r.value.nutrientsPer100g.calciumMg).toBe(113);
    expect(r.value.nutrientsPer100g.transFatG).toBeNull();
    expect(String(fetchMock.mock.calls[0]![0])).toContain('format=abridged');
  });

  it('404 → NOT_FOUND', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 404));
    const r = await getUsdaFood(999);
    expect(r).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('rejects a non-positive/non-integer fdcId without calling the API', async () => {
    for (const id of [0, -1, 1.5, Number.NaN]) {
      const r = await getUsdaFood(id);
      expect(r).toEqual({ ok: false, reason: 'NOT_FOUND' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
