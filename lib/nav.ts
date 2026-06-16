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
      { key: 'ingredients', href: '/ingredients' },
      { key: 'inventory', href: '/inventory' },
    ],
  },
  {
    key: 'finance',
    items: [
      { key: 'financials', href: '/financials' },
      { key: 'transactions', href: '/transactions' },
      { key: 'breakEven', href: '/break-even' },
      { key: 'invoices', href: '/invoices' },
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
