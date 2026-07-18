import { z } from 'zod';

import { usdaEnv } from '@/lib/env';
import type { NutrientKey } from '@/lib/calculations/nutrition';

/**
 * USDA FoodData Central client (Recipes 2.0 Fase 6, plan §6.7) — SERVER-ONLY.
 *
 * Uses only the official FDC search/detail endpoints, with the API key kept
 * exclusively on the server (query param, per the official API guide — never
 * logged, never in a client bundle). External output is UNTRUSTED input: every
 * payload is Zod-parsed, and nutrient values are normalized into the per-100 g
 * profile contract where a missing/unexpected nutrient stays `null` — never a
 * silent 0. USDA publishes FDC data under CC0; the selection dialog shows the
 * attribution (§9.6).
 *
 * Resilience: request timeout, ONE limited retry on network/5xx, and a small
 * in-process TTL cache (owner decision D4 — no cache table; the durable record
 * is the snapshot saved on the ingredient profile). Per-org rate limiting is
 * enforced by the calling action via the `usdaSearch` bucket, not here.
 */

const BASE_URL = 'https://api.nal.usda.gov/fdc/v1';
const TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 500;

/** Search scope shown as tabs in the UI (§9.6): Common vs Branded foods. */
export type UsdaScope = 'common' | 'branded';

const SCOPE_DATA_TYPES: Record<UsdaScope, string[]> = {
  common: ['Foundation', 'SR Legacy'],
  branded: ['Branded'],
};

/**
 * FDC nutrient NUMBER → profile column. Numbers are the stable public
 * identifiers used across FDC data types (abridged format exposes them
 * directly). Values in FDC are per 100 g for every data type, matching the
 * profile's per-100 g contract.
 */
const NUTRIENT_NUMBER_TO_KEY: Record<string, { key: NutrientKey; unit: string }> = {
  '208': { key: 'caloriesKcal', unit: 'KCAL' },
  '204': { key: 'totalFatG', unit: 'G' },
  '606': { key: 'saturatedFatG', unit: 'G' },
  '605': { key: 'transFatG', unit: 'G' },
  '601': { key: 'cholesterolMg', unit: 'MG' },
  '307': { key: 'sodiumMg', unit: 'MG' },
  '205': { key: 'totalCarbohydrateG', unit: 'G' },
  '291': { key: 'dietaryFiberG', unit: 'G' },
  '269': { key: 'totalSugarsG', unit: 'G' },
  '539': { key: 'addedSugarsG', unit: 'G' },
  '203': { key: 'proteinG', unit: 'G' },
  '328': { key: 'vitaminDMcg', unit: 'UG' },
  '301': { key: 'calciumMg', unit: 'MG' },
  '303': { key: 'ironMg', unit: 'MG' },
  '306': { key: 'potassiumMg', unit: 'MG' },
  '262': { key: 'caffeineMg', unit: 'MG' },
};

/** Abridged nutrient entry, shared by search results and abridged detail. */
const abridgedNutrientSchema = z.object({
  nutrientNumber: z.string().optional(),
  number: z.string().optional(),
  unitName: z.string().optional(),
  // `nullish`, not `optional`: FDC occasionally emits literal nulls, and a
  // weird entry must degrade to "unknown nutrient", never reject the payload.
  value: z.number().nullish(),
  amount: z.number().nullish(),
});

const searchFoodSchema = z.object({
  fdcId: z.number().int(),
  description: z.string(),
  dataType: z.string().optional(),
  brandOwner: z.string().nullish(),
  publishedDate: z.string().nullish(),
  foodNutrients: z.array(abridgedNutrientSchema).optional(),
});

const searchResponseSchema = z.object({
  totalHits: z.number().int().optional(),
  foods: z.array(searchFoodSchema).optional(),
});

const detailResponseSchema = z.object({
  fdcId: z.number().int(),
  description: z.string(),
  dataType: z.string().optional(),
  brandOwner: z.string().nullish(),
  publicationDate: z.string().nullish(),
  foodNutrients: z.array(abridgedNutrientSchema).optional(),
});

/** Normalized nutrient values per 100 g; null = the source omitted it. */
export type UsdaNutrientValues = Record<NutrientKey, number | null>;

export type UsdaFood = {
  fdcId: number;
  description: string;
  dataType: string | null;
  brandOwner: string | null;
  /** Source publication date string as provided by FDC (unparsed). */
  publishedDate: string | null;
  nutrientsPer100g: UsdaNutrientValues;
};

export type UsdaResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'INVALID_RESPONSE' | 'NOT_FOUND' };

function emptyNutrients(): UsdaNutrientValues {
  const out = {} as UsdaNutrientValues;
  for (const { key } of Object.values(NUTRIENT_NUMBER_TO_KEY)) out[key] = null;
  return out;
}

/**
 * Fold abridged nutrient entries into the profile contract. An unknown
 * nutrient number is ignored; a known one with an unexpected unit or a
 * negative/non-finite value stays null (untrusted input, honest absence).
 */
function normalizeNutrients(
  entries: z.infer<typeof abridgedNutrientSchema>[] | undefined,
): UsdaNutrientValues {
  const out = emptyNutrients();
  for (const entry of entries ?? []) {
    const number = entry.nutrientNumber ?? entry.number;
    if (!number) continue;
    const mapped = NUTRIENT_NUMBER_TO_KEY[number];
    if (!mapped) continue;
    if ((entry.unitName ?? '').toUpperCase() !== mapped.unit) continue;
    const value = entry.value ?? entry.amount;
    if (value == null || !Number.isFinite(value) || value < 0) continue;
    out[mapped.key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tiny in-process TTL cache (D4). Keyed by full request URL minus the API key.
// ---------------------------------------------------------------------------

type CacheEntry = { expires: number; body: unknown };
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): unknown | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return undefined;
  }
  return hit.body;
}

function cacheSet(key: string, body: unknown): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Drop the oldest entry (Map preserves insertion order).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, body });
}

/** Test hook: clear the module cache between cases. */
export function clearUsdaCache(): void {
  cache.clear();
}

/**
 * GET a FDC endpoint with timeout + one retry on network error/5xx. Returns the
 * parsed JSON body, a NOT_FOUND for 404, or UNAVAILABLE for anything else. The
 * API key travels only in the request; the cache key and errors never carry it.
 */
async function fdcGet(
  path: string,
  params: Record<string, string>,
): Promise<UsdaResult<unknown>> {
  const env = usdaEnv();
  if (!env) return { ok: false, reason: 'NOT_CONFIGURED' };

  const search = new URLSearchParams(params);
  const cacheKey = `${path}?${search.toString()}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return { ok: true, value: cached };

  search.set('api_key', env.apiKey);
  const url = `${BASE_URL}${path}?${search.toString()}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 404) return { ok: false, reason: 'NOT_FOUND' };
      if (res.status >= 500) {
        if (attempt === 0) continue; // one retry on a server error
        return { ok: false, reason: 'UNAVAILABLE' };
      }
      if (!res.ok) return { ok: false, reason: 'UNAVAILABLE' };
      const body: unknown = await res.json();
      cacheSet(cacheKey, body);
      return { ok: true, value: body };
    } catch {
      // Network error / timeout — retry once, then give up.
      if (attempt === 0) continue;
      return { ok: false, reason: 'UNAVAILABLE' };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: 'UNAVAILABLE' };
}

/**
 * Search foods by free text within a scope (Common or Branded). Returns up to
 * `pageSize` normalized results, each already carrying per-100 g nutrients so
 * the dialog can preview before the user confirms a selection.
 */
export async function searchUsdaFoods(
  query: string,
  scope: UsdaScope,
  pageSize = 15,
): Promise<UsdaResult<UsdaFood[]>> {
  const raw = await fdcGet('/foods/search', {
    query,
    dataType: SCOPE_DATA_TYPES[scope].join(','),
    pageSize: String(pageSize),
    pageNumber: '1',
  });
  if (!raw.ok) return raw;

  const parsed = searchResponseSchema.safeParse(raw.value);
  if (!parsed.success) return { ok: false, reason: 'INVALID_RESPONSE' };

  const foods = (parsed.data.foods ?? []).map((f) => ({
    fdcId: f.fdcId,
    description: f.description,
    dataType: f.dataType ?? null,
    brandOwner: f.brandOwner ?? null,
    publishedDate: f.publishedDate ?? null,
    nutrientsPer100g: normalizeNutrients(f.foodNutrients),
  }));
  return { ok: true, value: foods };
}

/**
 * Fetch one food by FDC id in abridged format (flat per-100 g nutrients) — the
 * authoritative payload snapshotted onto the ingredient profile on save.
 */
export async function getUsdaFood(fdcId: number): Promise<UsdaResult<UsdaFood>> {
  if (!Number.isInteger(fdcId) || fdcId <= 0) {
    return { ok: false, reason: 'NOT_FOUND' };
  }
  const raw = await fdcGet(`/food/${fdcId}`, { format: 'abridged' });
  if (!raw.ok) return raw;

  const parsed = detailResponseSchema.safeParse(raw.value);
  if (!parsed.success) return { ok: false, reason: 'INVALID_RESPONSE' };

  const f = parsed.data;
  return {
    ok: true,
    value: {
      fdcId: f.fdcId,
      description: f.description,
      dataType: f.dataType ?? null,
      brandOwner: f.brandOwner ?? null,
      publishedDate: f.publicationDate ?? null,
      nutrientsPer100g: normalizeNutrients(f.foodNutrients),
    },
  };
}
