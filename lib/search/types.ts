import type { UserRole } from '@/lib/auth';
import type { TenantTx } from '@/lib/db/tenant';

/**
 * Global search (Sprint 2.7) — shared contracts.
 *
 * Server-only modules (`queries.ts`, `registry.ts`, `run.ts`) consume the full
 * set; the ⌘K client only ever imports the result shapes ({@link SearchResult},
 * {@link SearchGroup}, {@link GroupedSearchResults}) as `import type`, so none of
 * the server-only references below ever reach the browser bundle.
 */

/** Entity kinds the registry can search. */
export type SearchEntityType =
  | 'recipe'
  | 'menu'
  | 'production'
  | 'taskList'
  | 'ingredient'
  | 'transaction'
  | 'invoice'
  | 'customer'
  | 'supplier'
  | 'purchaseOrder';

/**
 * One matched row as a descriptor's query returns it: ready-to-display fields
 * PLUS the raw relevance signals the pure ranker scores. Keeping the signals on
 * the row (instead of ranking in SQL) is what makes ordering unit-testable.
 */
export interface SearchCandidate {
  id: string;
  /** Primary label shown in the palette (recipe/ingredient name, note snippet). */
  title: string;
  /** Optional secondary line (supplier, amount · date, notes snippet). */
  subtitle: string | null;
  /** Deep-link the result navigates to when selected. */
  href: string;
  /** `similarity()` of the primary text column vs the query (0..1). */
  primarySim: number;
  /** `similarity()` of the secondary text column vs the query (0..1; 0 if none). */
  secondarySim: number;
  /** Primary column equals the query (case-insensitive). */
  exact: boolean;
  /** Primary column starts with the query (ILIKE prefix). */
  prefix: boolean;
  /** Primary column contains the query (ILIKE substring). */
  substring: boolean;
}

/** A ranked, display-ready search result (a candidate + its computed score). */
export interface SearchResult {
  type: SearchEntityType;
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
  score: number;
}

/** Results for one entity kind, in registry order, with empty groups dropped. */
export interface SearchGroup {
  type: SearchEntityType;
  /** Leaf i18n key under `search.groups.*`. */
  labelKey: string;
  results: SearchResult[];
}

export interface GroupedSearchResults {
  groups: SearchGroup[];
}

/** Everything a descriptor's query needs; built once per search by `runSearch`. */
export interface SearchContext {
  tx: TenantTx;
  organizationId: string;
  /** Already normalized (trimmed, whitespace-collapsed) and known searchable. */
  query: string;
  /** Max candidate rows to fetch from SQL (the pool the ranker then trims). */
  limit: number;
  /** Org currency, for formatting monetary subtitles (e.g. transactions). */
  currency: string;
}

/**
 * Pluggable per-entity descriptor. Adding invoices/customers in Sprint 3 is a new
 * entry in `SEARCH_REGISTRY` — the action, ranker and palette never change.
 */
export interface SearchDescriptor {
  type: SearchEntityType;
  /** Leaf i18n key under `search.groups.*`. */
  labelKey: string;
  /** RBAC predicate — runs BEFORE any query (financials are manager-only). */
  canAccess: (role: UserRole) => boolean;
  /** Builds + runs the org-scoped, soft-delete-aware candidate query. */
  search: (ctx: SearchContext) => Promise<SearchCandidate[]>;
}
