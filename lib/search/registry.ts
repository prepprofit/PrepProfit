import { canAccessFinancials, type UserRole } from '@/lib/auth';
import {
  searchCustomers,
  searchIngredients,
  searchInvoices,
  searchMenus,
  searchPurchaseOrders,
  searchRecipes,
  searchSuppliers,
  searchTransactions,
} from './queries';
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
    type: 'menu',
    labelKey: 'menus',
    // Menus are operational (kitchen sees a money-free view) — both roles search.
    canAccess: () => true,
    search: searchMenus,
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
  {
    type: 'invoice',
    labelKey: 'invoices',
    // Invoices are financial / billing data — manager-only, like transactions.
    canAccess: canAccessFinancials,
    search: searchInvoices,
  },
  {
    type: 'customer',
    labelKey: 'customers',
    // Customers exist only for billing — manager-only.
    canAccess: canAccessFinancials,
    search: searchCustomers,
  },
  {
    type: 'supplier',
    labelKey: 'suppliers',
    // Suppliers are procurement/financial data — manager-only (Sprint 7, F4).
    canAccess: canAccessFinancials,
    search: searchSuppliers,
  },
  {
    type: 'purchaseOrder',
    labelKey: 'purchaseOrders',
    // Purchase orders are procurement/financial data — manager-only (Sprint 8a, F4).
    canAccess: canAccessFinancials,
    search: searchPurchaseOrders,
  },
];

/** Descriptors the given role may search — the RBAC gate for global search. */
export function accessibleDescriptors(role: UserRole): SearchDescriptor[] {
  return SEARCH_REGISTRY.filter((descriptor) => descriptor.canAccess(role));
}
