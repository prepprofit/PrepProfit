import { NextResponse } from 'next/server';
import { clerkClient } from '@clerk/nextjs/server';
import { getDb, withOrg } from '@/lib/db';
import { isCronAuthorized } from '@/lib/cron-auth';
import { enforceRateLimit } from '@/lib/rate-limit';
import { serverEnv } from '@/lib/env';
import { logError } from '@/lib/observability';
import {
  listSweepableRecipeMedia,
  hardDeleteRecipeMedia,
} from '@/lib/data/recipe-media';
import { getRecipeMediaStorage } from '@/lib/media/recipe-media-storage';

// Needs Node (neon-serverless Pool + Blob SDK), never cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 100;
/** pending/rejected uploads and soft-deleted media older than this are swept. */
const SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Daily recipe-media cleanup (Fase 3, plan §6.4): per org (RULE #1, inside
 * `withOrg`), finds `pending`/`rejected` rows whose upload never completed and
 * soft-`deleted` rows past the retention cutoff, removes the bucket objects
 * OUTSIDE the transaction (idempotent — a missing object is a no-op), then
 * hard-deletes exactly the rows whose objects were removed. A per-org failure
 * is logged and never blocks the other orgs.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const authHeader = req.headers.get('authorization');
  if (!isCronAuthorized(authHeader, serverEnv().CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const limit = await enforceRateLimit(getDb(), 'mediaSweep', authHeader ?? '');
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const cutoff = new Date(Date.now() - SWEEP_AGE_MS);
  const storage = getRecipeMediaStorage();
  const client = await clerkClient();

  let offset = 0;
  let orgs = 0;
  let swept = 0;
  let failures = 0;

  for (;;) {
    const { data, totalCount } = await client.organizations.getOrganizationList({
      limit: PAGE_SIZE,
      offset,
    });
    if (data.length === 0) break;

    for (const org of data) {
      try {
        const candidates = await withOrg(org.id, (tx) =>
          listSweepableRecipeMedia(tx, org.id, cutoff),
        );
        if (candidates.length === 0) {
          orgs += 1;
          continue;
        }
        // Remove objects first (idempotent); only rows whose object removal
        // succeeded are hard-deleted, so a bucket hiccup retries tomorrow.
        const removedIds: string[] = [];
        for (const candidate of candidates) {
          try {
            await storage.remove(candidate.storageKey);
            removedIds.push(candidate.id);
          } catch (error) {
            failures += 1;
            logError(
              { action: 'cron.sweepRecipeMedia.remove', orgId: org.id },
              error,
            );
          }
        }
        swept += await withOrg(org.id, (tx) =>
          hardDeleteRecipeMedia(tx, org.id, removedIds),
        );
        orgs += 1;
      } catch (error) {
        failures += 1;
        logError({ action: 'cron.sweepRecipeMedia', orgId: org.id }, error);
      }
    }

    offset += data.length;
    if (offset >= totalCount) break;
  }

  return NextResponse.json({
    ok: true,
    cutoff: cutoff.toISOString(),
    orgs,
    swept,
    failures,
  });
}
