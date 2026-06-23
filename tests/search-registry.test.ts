import { describe, it, expect } from 'vitest';
import {
  SEARCH_REGISTRY,
  accessibleDescriptors,
} from '@/lib/search/registry';

/**
 * The registry's RBAC filter is the gate that keeps kitchen staff out of
 * financial search results — proven here as a pure check, complementing the
 * PGlite integration test that verifies no transaction rows are ever queried.
 */
describe('accessibleDescriptors (search RBAC)', () => {
  it('excludes all financial entities for a kitchen user', () => {
    const types = accessibleDescriptors('kitchen').map((d) => d.type);
    expect(types).not.toContain('transaction');
    expect(types).not.toContain('invoice');
    expect(types).not.toContain('customer');
    expect(types).not.toContain('supplier');
    expect(types).not.toContain('sale');
    // Menus, productions + task lists are operational (money-free for kitchen, F4)
    // → searchable.
    expect(types).toEqual([
      'recipe',
      'menu',
      'production',
      'taskList',
      'ingredient',
    ]);
  });

  it('includes transactions, invoices, customers, suppliers, purchase orders and sales for a manager', () => {
    const types = accessibleDescriptors('manager').map((d) => d.type);
    expect(types).toEqual([
      'recipe',
      'menu',
      'production',
      'taskList',
      'ingredient',
      'transaction',
      'invoice',
      'customer',
      'supplier',
      'purchaseOrder',
      'sale',
    ]);
  });

  it('every descriptor has a unique type and a group label key', () => {
    const types = SEARCH_REGISTRY.map((d) => d.type);
    expect(new Set(types).size).toBe(types.length);
    for (const d of SEARCH_REGISTRY) {
      expect(d.labelKey.length).toBeGreaterThan(0);
    }
  });
});
