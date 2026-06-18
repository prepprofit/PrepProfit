import { NextResponse } from 'next/server';
import { clerkClient } from '@clerk/nextjs/server';
import { getDb, withOrg } from '@/lib/db';
import { purgeExpired } from '@/lib/data/trash';
import { writeAuditEvent } from '@/lib/data/audit';
import { isCronAuthorized } from '@/lib/cron-auth';
import { enforceRateLimit } from '@/lib/rate-limit';
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
  const authHeader = req.headers.get('authorization');
  if (!isCronAuthorized(authHeader, serverEnv().CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Abuse control (Sprint 3.1): keyed on a HASH of the auth header (never the raw
  // secret), on the un-scoped infra table — the cron route has no org context.
  const limit = await enforceRateLimit(getDb(), 'cronPurge', authHeader ?? '');
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const cutoff = purgeCutoff();
  const client = await clerkClient();

  let offset = 0;
  let orgs = 0;
  let purgedRecipes = 0;
  let purgedIngredients = 0;
  let purgedTransactions = 0;
  let purgedCustomers = 0;
  let purgedInvoices = 0;

  for (;;) {
    const { data, totalCount } = await client.organizations.getOrganizationList({
      limit: PAGE_SIZE,
      offset,
    });
    if (data.length === 0) break;

    for (const org of data) {
      const result = await withOrg(org.id, async (tx) => {
        const purged = await purgeExpired(tx, org.id, cutoff);
        // Audit the purge per org (Sprint 3.1), inside the same tx so it commits
        // atomically. Actor is the org-less cron → `system` role, null user id.
        if (
          purged.recipes +
            purged.ingredients +
            purged.transactions +
            purged.customers +
            purged.invoices >
          0
        ) {
          await writeAuditEvent(
            tx,
            org.id,
            { userId: null, role: 'system', requestId: crypto.randomUUID() },
            {
              action: 'cron.purge',
              entityType: 'trash',
              metadata: {
                cutoff: cutoff.toISOString(),
                ...purged,
              },
            },
          );
        }
        return purged;
      });
      purgedRecipes += result.recipes;
      purgedIngredients += result.ingredients;
      purgedTransactions += result.transactions;
      purgedCustomers += result.customers;
      purgedInvoices += result.invoices;
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
    purgedTransactions,
    purgedCustomers,
    purgedInvoices,
  });
}
