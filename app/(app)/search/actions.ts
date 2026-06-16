'use server';

import { z } from 'zod';
import { getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { unexpected } from '@/lib/observability';
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
});

export async function globalSearchAction(
  input: unknown,
): Promise<ActionResult<GroupedSearchResults>> {
  const parsed = searchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const role = await getUserRole();

  try {
    const data = await withOrg(organizationId, (tx) =>
      runSearch(tx, organizationId, role, parsed.data.query),
    );
    return { ok: true, data };
  } catch (err) {
    return unexpected('globalSearchAction', err, organizationId);
  }
}
