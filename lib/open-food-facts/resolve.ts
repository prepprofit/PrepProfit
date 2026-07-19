import type { NeonDatabase } from 'drizzle-orm/neon-serverless';

import type * as schema from '@/lib/db/schema';
import { offEnv } from '@/lib/env';
import type { ExternalFoodSnapshot } from '@/lib/external-food/types';
import { lookupOffProduct } from './client';
import { NORMALIZATION_VERSION, normalizeOffProduct } from './normalize';
import { getCachedFood, putCachedFood } from '@/lib/data/external-food-cache';

/**
 * Open Food Facts resolver (plan §13) — wraps the raw client with the persistent
 * cache and an in-process circuit breaker, and is the single entry point the
 * action layer calls to obtain an authoritative `ExternalFoodSnapshot` by
 * barcode (both for the initial lookup and the server-side re-resolve on save).
 *
 * Cache: fresh (24h) short-circuits the provider; on provider failure, an
 * eligible stale entry (≤30d) is served with `stale: true`.
 *
 * Circuit breaker: opens after N consecutive provider/network failures; while
 * open it serves eligible cache or a stable UNAVAILABLE, and probes after a
 * cooldown. It NEVER opens on an ordinary product 404 (not-found is healthy).
 */

type Db = NeonDatabase<typeof schema>;

const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 30_000;

/** In-process breaker state (per server instance). Reset via the test hook. */
const breaker = { failures: 0, openUntil: 0 };

/** Test hook: reset the circuit breaker between cases (plan §7). */
export function resetOffResolverState(): void {
  breaker.failures = 0;
  breaker.openUntil = 0;
}

function breakerIsOpen(now: number): boolean {
  return now < breaker.openUntil;
}

function recordSuccess(): void {
  breaker.failures = 0;
  breaker.openUntil = 0;
}

function recordFailure(now: number): void {
  breaker.failures += 1;
  if (breaker.failures >= FAILURE_THRESHOLD) {
    breaker.openUntil = now + COOLDOWN_MS;
  }
}

/** Structured, PAYLOAD-FREE observability event (plan §18). */
function logEvent(fields: Record<string, string | number | boolean | null>): void {
  console.log(
    JSON.stringify({ level: 'info', at: new Date().toISOString(), ...fields }),
  );
}

export type OffResolveResult =
  | { ok: true; snapshot: ExternalFoodSnapshot; stale: boolean }
  | {
      ok: false;
      reason:
        | 'DISABLED'
        | 'NOT_FOUND'
        | 'UNAVAILABLE'
        | 'NON_FOOD'
        | 'MISSING_NAME'
        | 'BASIS_UNSUPPORTED'
        | 'INVALID';
    };

/**
 * Resolve a product by its sanitized barcode. `forceRefresh` bypasses the fresh
 * cache (an explicit refresh) but still falls back to stale on provider failure.
 */
export async function resolveOffByBarcode(
  db: Db,
  barcode: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<OffResolveResult> {
  if (!offEnv()) return { ok: false, reason: 'DISABLED' };
  const now = Date.now();

  const cached = await getCachedFood(
    db,
    'open_food_facts',
    barcode,
    NORMALIZATION_VERSION,
    new Date(now),
  );
  if (!opts.forceRefresh && cached.status === 'fresh') {
    logEvent({ event: 'off_lookup', outcome: 'cache_fresh', barcodeLen: barcode.length });
    return { ok: true, snapshot: cached.snapshot, stale: false };
  }

  const serveStale = (): OffResolveResult | null =>
    cached.status === 'stale' || cached.status === 'fresh'
      ? { ok: true, snapshot: cached.snapshot, stale: true }
      : null;

  if (breakerIsOpen(now)) {
    const stale = serveStale();
    logEvent({
      event: 'off_lookup',
      outcome: stale ? 'breaker_open_stale' : 'breaker_open_unavailable',
      barcodeLen: barcode.length,
    });
    return stale ?? { ok: false, reason: 'UNAVAILABLE' };
  }

  const start = Date.now();
  const lookup = await lookupOffProduct(barcode);
  const latencyMs = Date.now() - start;

  if (lookup.ok) {
    // Provider responded → healthy, regardless of data quality.
    recordSuccess();
    const normalized = normalizeOffProduct(lookup.product, barcode);
    if (normalized.ok) {
      await putCachedFood(db, normalized.snapshot, new Date());
      logEvent({
        event: 'off_lookup',
        outcome: 'provider_ok',
        quality: normalized.snapshot.qualityStatus,
        latencyMs,
      });
      return { ok: true, snapshot: normalized.snapshot, stale: false };
    }
    // A rejected product is NOT cached and never a provider failure.
    logEvent({ event: 'off_lookup', outcome: 'rejected', reason: normalized.reason, latencyMs });
    return { ok: false, reason: normalized.reason };
  }

  if (lookup.reason === 'NOT_FOUND') {
    recordSuccess(); // 404 is a healthy provider response — never trips the breaker.
    logEvent({ event: 'off_lookup', outcome: 'not_found', latencyMs });
    return { ok: false, reason: 'NOT_FOUND' };
  }

  if (lookup.reason === 'DISABLED') return { ok: false, reason: 'DISABLED' };

  // RATE_LIMITED / INVALID_RESPONSE / UNAVAILABLE → provider is unhealthy.
  recordFailure(now);
  const stale = serveStale();
  logEvent({
    event: 'off_lookup',
    outcome: stale ? 'provider_fail_stale' : 'provider_fail',
    reason: lookup.reason,
    breakerFailures: breaker.failures,
    latencyMs,
  });
  return stale ?? { ok: false, reason: 'UNAVAILABLE' };
}
