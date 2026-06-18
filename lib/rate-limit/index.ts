import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { rateLimits } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { RATE_LIMITS, type RateLimitBucket, type RateLimitConfig } from './config';

/**
 * Postgres-backed fixed-window rate limiter (Sprint 3.1). No new infra — it uses
 * the `rate_limits` table on the existing Neon database. One atomic statement per
 * check (`INSERT … ON CONFLICT DO UPDATE`) so concurrent hits can't race the
 * counter: the window resets in-place when it has expired, otherwise the count is
 * incremented.
 *
 * The `rate_limits` table has NO RLS (it is infra, not tenant data — see its
 * schema comment), so callers pass `getDb()` directly, OUTSIDE `withOrg`. That is
 * what lets the org-less cron route share the same limiter.
 */

export type RateLimitResult = {
  allowed: boolean;
  /** Hits left in the current window (0 once blocked). */
  remaining: number;
  /** When the current window resets (window_start + windowMs). */
  resetAt: Date;
};

/**
 * Build an OPAQUE limiter key. The scope (which encodes the tenant/user, or the
 * cron auth header) is SHA-256 hashed, so the stored key never contains a raw
 * organization id, user id, or secret — important because the table has no RLS.
 */
export function rateLimitKey(bucket: RateLimitBucket, scope: string): string {
  const digest = createHash('sha256').update(scope).digest('hex');
  return `${bucket}:${digest}`;
}

/**
 * Atomically record a hit against `key` and report whether it is allowed. `db` is
 * any tenant client; production callers pass the un-scoped prod client (the table
 * is not org-scoped), tests pass the PGlite client.
 */
export async function checkRateLimit(
  db: TenantClient,
  key: string,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  // `window_start <= now() - windowMs` ⇒ the previous window expired → reset to 1;
  // otherwise increment. Computed in SQL so it uses the DB clock, not the app's.
  const expired = sql`${rateLimits.windowStart} <= now() - interval '1 millisecond' * ${config.windowMs}`;

  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart: sql`now()`, count: 1 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`case when ${expired} then 1 else ${rateLimits.count} + 1 end`,
        windowStart: sql`case when ${expired} then now() else ${rateLimits.windowStart} end`,
      },
    })
    .returning({ count: rateLimits.count, windowStart: rateLimits.windowStart });

  if (!row) throw new Error('Rate limit check returned no row.');

  const windowStart =
    row.windowStart instanceof Date ? row.windowStart : new Date(row.windowStart);
  return {
    allowed: row.count <= config.limit,
    remaining: Math.max(0, config.limit - row.count),
    resetAt: new Date(windowStart.getTime() + config.windowMs),
  };
}

/** Convenience: hash the scope, look up the bucket config, and check in one call. */
export function enforceRateLimit(
  db: TenantClient,
  bucket: RateLimitBucket,
  scope: string,
): Promise<RateLimitResult> {
  return checkRateLimit(db, rateLimitKey(bucket, scope), RATE_LIMITS[bucket]);
}
