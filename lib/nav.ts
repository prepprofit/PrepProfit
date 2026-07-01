/**
 * Product modules (parity with the original PrepProfit spreadsheet kit), grouped
 * for the sidebar. `key` = i18n key under `nav`; `group.key` = key under
 * `navGroups`. Grouping mirrors DESIGN.md §6.
 */
export const navGroups = [
  {
    key: 'operations',
    items: [
      { key: 'dashboard', href: '/dashboard' },
      { key: 'recipes', href: '/recipes' },
      // Menus / combos (Sprint 10) — visible to BOTH roles (kitchen sees an
      // operational, money-free view); lives in Operations near Recipes.
      { key: 'menus', href: '/menus' },
      // Production planning (Sprint 11a) — visible to BOTH roles (kitchen plans a
      // money-free batch; manager also sees cost). Operations group.
      { key: 'productions', href: '/productions' },
      { key: 'ingredients', href: '/ingredients' },
      { key: 'inventory', href: '/inventory' },
      // Kitchen task / prep / reorder lists (Sprint 6) — visible to BOTH roles
      // (operational, money-free). Operations group.
      { key: 'tasks', href: '/tasks' },
    ],
  },
  {
    key: 'finance',
    items: [
      { key: 'financials', href: '/financials' },
      // Profit Insight Inbox (Sprint 4, AI margin roadmap) — manager-only margin-risk
      // triage with AI explanations; finance group so kitchen hides it (server enforces).
      { key: 'insights', href: '/insights' },
      { key: 'transactions', href: '/transactions' },
      // Daily-close sales (Sprint 12a) — manager-only financial data; lives in the
      // finance group so the kitchen-role sidebar hides it (server enforces too).
      { key: 'sales', href: '/sales' },
      { key: 'breakEven', href: '/break-even' },
      { key: 'invoices', href: '/invoices' },
      // Suppliers (Sprint 7) — manager-only procurement data; lives in the
      // finance group so the kitchen-role sidebar hides it (server enforces too).
      { key: 'suppliers', href: '/suppliers' },
      // Purchase orders (Sprint 8a) — manager-only procurement documents.
      { key: 'purchaseOrders', href: '/purchase-orders' },
    ],
  },
  {
    key: 'team',
    items: [{ key: 'payroll', href: '/payroll' }],
  },
] as const;

export type NavGroup = (typeof navGroups)[number];
export type NavGroupKey = NavGroup['key'];
export type NavItem = NavGroup['items'][number];
export type NavKey = NavItem['key'];

/** Flat list — for callers that need every item (icon map, active-title lookup). */
export const navItems: readonly NavItem[] = navGroups.flatMap(
  (group): readonly NavItem[] => group.items,
);
