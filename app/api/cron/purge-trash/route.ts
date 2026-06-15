import { NextResponse } from 'next/server';
import { clerkClient } from '@clerk/nextjs/server';
import { withOrg } from '@/lib/db';
import { purgeExpired } from '@/lib/data/trash';
import { isCronAuthorized } from '@/lib/cron-auth';
import { purgeCutoff } from '@/lib/trash';
import { serverEnv } from '@/lib/env';

// Needs Node (neon-serverless Pool/WebSocket + node:crypto), never the Edge
// runtime; force-dynamic so it is never statically cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 100;

/**
 * Daily auto-purge of trash past the retention window. Authenticated by
 * CRON_SECRET (Vercel Cron sends it automatically), NOT a user session — this is
 * the one route excluded from Clerk in middleware.ts.
 *
 * Purge is per-organization (RULE #1): we page through every org via Clerk and
 * run {@link purgeExpired} inside `withOrg`, so RLS stays active and no policy
 * carve-out is needed for a cross-org job.
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (
    !isCronAuthorized(
      req.headers.get('authorization'),
      serverEnv().CRON_SECRET,
    )
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const cutoff = purgeCutoff();
  const client = await clerkClient();

  let offset = 0;
  let orgs = 0;
  let purgedRecipes = 0;
  let purgedIngredients = 0;

  for (;;) {
    const { data, totalCount } = await client.organizations.getOrganizationList({
      limit: PAGE_SIZE,
      offset,
    });
    if (data.length === 0) break;

    for (const org of data) {
      const result = await withOrg(org.id, (tx) =>
        purgeExpired(tx, org.id, cutoff),
      );
      purgedRecipes += result.recipes;
      purgedIngredients += result.ingredients;
      orgs += 1;
    }

    offset += data.length;
    if (offset >= totalCount) break;
  }

  return NextResponse.json({
    ok: true,
    cutoff: cutoff.toISOString(),
    orgs,
    purgedRecipes,
    purgedIngredients,
  });
}
