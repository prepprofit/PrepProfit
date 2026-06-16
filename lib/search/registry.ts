import { canAccessFinancials, type UserRole } from '@/lib/auth';
import { searchIngredients, searchRecipes, searchTransactions } from './queries';
import type { SearchDescriptor } from './types';

/**
 * The pluggable search registry (Sprint 2.7). Each entity registers a typed
 * descriptor; the action, ranker and ⌘K palette are entity-agnostic, so adding
 * invoices/customers in Sprint 3 is two new entries here (with their RBAC rule)
 * and nothing else changes.
 *
 * Order here is the order groups appear in the palette.
 */
export const SEARCH_REGISTRY: readonly SearchDescriptor[] = [
  {
    type: 'recipe',
    labelKey: 'recipes',
    canAccess: () => true,
    search: searchRecipes,
  },
  {
    type: 'ingredient',
    labelKey: 'ingredients',
    canAccess: () => true,
    search: searchIngredients,
  },
  {
    type: 'transaction',
    labelKey: 'transactions',
    // Financials are manager-only (CLAUDE.md / DoD): a kitchen user never even
    // queries transactions — this filter runs before any SQL.
    canAccess: canAccessFinancials,
    search: searchTransactions,
  },
];

/** Descriptors the given role may search — the RBAC gate for global search. */
export function accessibleDescriptors(role: UserRole): SearchDescriptor[] {
  return SEARCH_REGISTRY.filter((descriptor) => descriptor.canAccess(role));
}
