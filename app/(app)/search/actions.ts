'use server';

import { z } from 'zod';
import { getOrgId, getUserId, getUserRole } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { unexpected } from '@/lib/observability';
import { enforceRateLimit } from '@/lib/rate-limit';
import { runSearch } from '@/lib/search/run';
import type { ActionResult } from '@/lib/action-result';
import type { GroupedSearchResults } from '@/lib/search/types';

/**
 * Global search (Sprint 2.7). RULE #1: the org id comes from Clerk on the server,
 * never the client; the role is likewise server-derived and gates which entities
 * are queried (kitchen staff never reach transactions). Runs inside `withOrg` so
 * RLS is active; `runSearch` does the normalize/short-circuit, ranking + grouping.
 */
const searchSchema = z.object({
  // Bounded to keep the trigram query cheap; below MIN_QUERY_LEN runSearch
  // returns nothing without touching the DB.
  query: z.string().max(100),
  // Optional single-entity filter (the palette's filter pills). Intersected with
  // the role-accessible set server-side, so it can never widen RBAC.
  type: z.enum(['recipe', 'ingredient', 'transaction']).optional(),
});

export async function globalSearchAction(
  input: unknown,
): Promise<ActionResult<GroupedSearchResults>> {
  const parsed = searchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const userId = await getUserId();
  const role = await getUserRole();

  try {
    // Abuse control (Sprint 3.1): per org+user, on the un-scoped infra table —
    // checked before the org work so a flood never reaches the trigram queries.
    const limit = await enforceRateLimit(
      getDb(),
      'search',
      `${organizationId}:${userId}`,
    );
    if (!limit.allowed) return { ok: false, code: 'RATE_LIMITED' };

    const data = await withOrg(organizationId, (tx) =>
      runSearch(tx, organizationId, role, parsed.data.query, {
        type: parsed.data.type,
        // A single-entity view shows a deeper list (the "Show more" affordance);
        // the mixed "All" view stays at the default compact cap per group.
        perEntityLimit: parsed.data.type ? 20 : undefined,
      }),
    );
    return { ok: true, data };
  } catch (err) {
    return unexpected('globalSearchAction', err, organizationId);
  }
}
