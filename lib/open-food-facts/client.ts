import { offEnv } from '@/lib/env';
import { isNotFound, offResponseSchema, type OffProduct } from './schemas';

/**
 * Open Food Facts v3 product-read client (plan §7) — SERVER-ONLY.
 *
 * Used ONLY for individual, user-initiated barcode lookups/refreshes. NEVER
 * crawls, enumerates, or bulk-syncs (plan §2). Read access needs no API key; a
 * descriptive `User-Agent` is mandatory (see `offEnv`). External output is
 * UNTRUSTED — every payload is Zod-parsed (`schemas.ts`) and normalized
 * (`normalize.ts`); this module only performs the HTTP call + parse.
 *
 * Resilience: request timeout, ONE retry on network error / 5xx with small
 * jitter, and NO automatic retry on 400/404/429 (plan §7). The persistent cache,
 * circuit breaker and rate limiting wrap this client in a later slice.
 *
 * Privacy: the request URL embeds the user-entered barcode, so nothing here is
 * logged — failures are returned as opaque reasons, never console output.
 */

/** Pinned API version (spike started against v3.6; see the ADR). */
const API_VERSION = 'v3';
const TIMEOUT_MS = 6_000;

/** Only the documented fields PrepProfit needs (plan §7). */
const FIELDS = [
  'code',
  'product_name',
  'product_name_en',
  'generic_name',
  'brands',
  'quantity',
  'lang',
  'product_type',
  'countries_tags',
  'nutrition_data_per',
  'serving_size',
  'nutriments',
  'rev',
  'last_modified_t',
].join(',');

export type OffLookupResult =
  | { ok: true; product: OffProduct }
  | {
      ok: false;
      reason: 'DISABLED' | 'NOT_FOUND' | 'INVALID_RESPONSE' | 'UNAVAILABLE' | 'RATE_LIMITED';
    };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Look up one product by its (already sanitized) barcode. The barcode is passed
 * to OFF as a string; the caller stores the normalized `product.code` OFF returns.
 */
export async function lookupOffProduct(barcode: string): Promise<OffLookupResult> {
  const env = offEnv();
  if (!env) return { ok: false, reason: 'DISABLED' };

  const url = `${env.baseUrl}/api/${API_VERSION}/product/${encodeURIComponent(
    barcode,
  )}?fields=${FIELDS}`;
  const headers = {
    'User-Agent': env.userAgent,
    Accept: 'application/json',
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      // Never auto-retry these (plan §7).
      if (res.status === 404) return { ok: false, reason: 'NOT_FOUND' };
      if (res.status === 429) return { ok: false, reason: 'RATE_LIMITED' };
      if (res.status === 400) return { ok: false, reason: 'INVALID_RESPONSE' };
      if (res.status >= 500) {
        if (attempt === 0) {
          await sleep(50 + Math.floor(Math.random() * 100)); // jitter
          continue;
        }
        return { ok: false, reason: 'UNAVAILABLE' };
      }
      if (!res.ok) return { ok: false, reason: 'UNAVAILABLE' };

      const body: unknown = await res.json();
      const parsed = offResponseSchema.safeParse(body);
      if (!parsed.success) return { ok: false, reason: 'INVALID_RESPONSE' };
      if (isNotFound(parsed.data) || parsed.data.product == null) {
        return { ok: false, reason: 'NOT_FOUND' };
      }
      return { ok: true, product: parsed.data.product };
    } catch {
      if (attempt === 0) {
        await sleep(50 + Math.floor(Math.random() * 100));
        continue;
      }
      return { ok: false, reason: 'UNAVAILABLE' };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: 'UNAVAILABLE' };
}
