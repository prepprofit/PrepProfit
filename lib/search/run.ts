import { sql } from 'drizzle-orm';
import type { UserRole } from '@/lib/auth';
import type { TenantTx } from '@/lib/db/tenant';
import { DEFAULT_ORG_SETTINGS, getOrgSettingsRow } from '@/lib/data/org-settings';
import { accessibleDescriptors } from './registry';
import { isSearchable, normalizeQuery, rankCandidates } from './ranking';
import type { GroupedSearchResults, SearchGroup } from './types';

/** Final results shown per entity group in the palette. */
const DEFAULT_PER_ENTITY_LIMIT = 5;

/**
 * Core global-search orchestration (Sprint 2.7). Pure of auth/HTTP — it takes an
 * org-scoped `tx` (RLS already active via `withOrg`) and a server-derived role,
 * so the PGlite integration tests can exercise isolation + RBAC + ranking against
 * a real database without mocking Clerk.
 *
 * RBAC is enforced FIRST via `accessibleDescriptors(role)`: a kitchen user's loop
 * never includes the transaction descriptor, so financial data is never queried.
 */
export async function runSearch(
  tx: TenantTx,
  organizationId: string,
  role: UserRole,
  rawQuery: string,
  opts: { perEntityLimit?: number } = {},
): Promise<GroupedSearchResults> {
  const query = normalizeQuery(rawQuery);
  if (!isSearchable(query)) return { groups: [] };

  const perEntityLimit = opts.perEntityLimit ?? DEFAULT_PER_ENTITY_LIMIT;
  // Fetch a wider candidate pool than we display: a literal substring match can
  // have low trigram similarity, so we must not let SQL's similarity ORDER BY
  // trim it before the ranker (which boosts ILIKE matches) gets to see it.
  const poolSize = Math.max(perEntityLimit * 4, 20);

  // Loosen the `%` operator threshold (default 0.3 is strict for short kitchen
  // terms). LOCAL = transaction-scoped, so it never leaks past this search.
  await tx.execute(sql`SET LOCAL pg_trgm.similarity_threshold = 0.2`);

  const settings = await getOrgSettingsRow(tx, organizationId);
  const currency = settings?.currency ?? DEFAULT_ORG_SETTINGS.currency;

  const groups: SearchGroup[] = [];
  // Sequential: one connection per tx, so descriptor queries can't run in parallel.
  for (const descriptor of accessibleDescriptors(role)) {
    const candidates = await descriptor.search({
      tx,
      organizationId,
      query,
      limit: poolSize,
      currency,
    });
    const results = rankCandidates(descriptor.type, candidates).slice(
      0,
      perEntityLimit,
    );
    if (results.length > 0) {
      groups.push({
        type: descriptor.type,
        labelKey: descriptor.labelKey,
        results,
      });
    }
  }
  return { groups };
}
