import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';

import { externalFoodCache } from '@/lib/db/schema';
import type * as schema from '@/lib/db/schema';
import type {
  ExternalFoodSnapshot,
  NutritionProviderId,
} from '@/lib/external-food/types';

/**
 * External-food cache data layer (Open Food Facts integration plan §6.3/§13).
 *
 * PUBLIC reference data (no org/user/pricing/search data) → read/written through
 * the UNTENANTED client OUTSIDE `withOrg`, exactly like `rate_limits`. Stores the
 * VALIDATED normalized snapshot, never the raw provider body.
 *
 * Freshness: fresh for 24h (`expires_at`), then serve-stale-on-error for up to
 * 30 days from `fetched_at`. A row whose stored `normalization_version` differs
 * from the snapshot's current version is treated as a MISS (mapping changed), so
 * bumping the normalizer transparently invalidates the cache.
 */

/** Untenanted client — the cache is not org-scoped. */
type Db = NeonDatabase<typeof schema>;

export const CACHE_FRESH_MS = 24 * 60 * 60 * 1000; // 24 hours
export const CACHE_STALE_MAX_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** JSON form of a snapshot (Date → ISO string) as stored in `normalized_payload`. */
type StoredSnapshot = Omit<ExternalFoodSnapshot, 'sourceUpdatedAt'> & {
  sourceUpdatedAt: string | null;
};

export type CacheLookup =
  | { status: 'fresh'; snapshot: ExternalFoodSnapshot; sourceUpdatedAt: Date | null }
  | { status: 'stale'; snapshot: ExternalFoodSnapshot; sourceUpdatedAt: Date | null }
  | { status: 'miss' };

function serialize(snapshot: ExternalFoodSnapshot): StoredSnapshot {
  return {
    ...snapshot,
    sourceUpdatedAt: snapshot.sourceUpdatedAt
      ? snapshot.sourceUpdatedAt.toISOString()
      : null,
  };
}

function hydrate(stored: StoredSnapshot): ExternalFoodSnapshot {
  const parsed = stored.sourceUpdatedAt ? new Date(stored.sourceUpdatedAt) : null;
  return {
    ...stored,
    sourceUpdatedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
  };
}

/** Stable identity of the normalized payload — debug/audit, not a secret. */
export function payloadHash(snapshot: ExternalFoodSnapshot): string {
  return createHash('sha256')
    .update(JSON.stringify(serialize(snapshot)))
    .digest('hex');
}

/**
 * Look up a cached product. `normalizationVersion` is the CURRENT version the
 * caller normalizes with; a row from an older version is a MISS.
 */
export async function getCachedFood(
  db: Db,
  provider: NutritionProviderId,
  externalId: string,
  normalizationVersion: number,
  now: Date = new Date(),
): Promise<CacheLookup> {
  const [row] = await db
    .select()
    .from(externalFoodCache)
    .where(
      and(
        eq(externalFoodCache.provider, provider),
        eq(externalFoodCache.externalId, externalId),
      ),
    )
    .limit(1);
  if (!row) return { status: 'miss' };
  if (row.normalizationVersion !== normalizationVersion) return { status: 'miss' };

  const snapshot = hydrate(row.normalizedPayload as StoredSnapshot);
  const sourceUpdatedAt = row.sourceUpdatedAt ?? snapshot.sourceUpdatedAt;
  const fetched = row.fetchedAt.getTime();
  const nowMs = now.getTime();
  if (nowMs < row.expiresAt.getTime()) {
    return { status: 'fresh', snapshot, sourceUpdatedAt };
  }
  if (nowMs - fetched <= CACHE_STALE_MAX_MS) {
    return { status: 'stale', snapshot, sourceUpdatedAt };
  }
  return { status: 'miss' };
}

/** Insert/replace the cache row for a freshly resolved snapshot. */
export async function putCachedFood(
  db: Db,
  snapshot: ExternalFoodSnapshot,
  now: Date = new Date(),
): Promise<void> {
  const stored = serialize(snapshot);
  const row = {
    provider: snapshot.provider,
    externalId: snapshot.externalId,
    normalizedPayload: stored,
    sourceUpdatedAt: snapshot.sourceUpdatedAt,
    fetchedAt: now,
    expiresAt: new Date(now.getTime() + CACHE_FRESH_MS),
    normalizationVersion: snapshot.normalizationVersion,
    payloadHash: payloadHash(snapshot),
  };
  await db
    .insert(externalFoodCache)
    .values(row)
    .onConflictDoUpdate({
      target: [externalFoodCache.provider, externalFoodCache.externalId],
      set: {
        normalizedPayload: row.normalizedPayload,
        sourceUpdatedAt: row.sourceUpdatedAt,
        fetchedAt: row.fetchedAt,
        expiresAt: row.expiresAt,
        normalizationVersion: row.normalizationVersion,
        payloadHash: row.payloadHash,
      },
    });
}
