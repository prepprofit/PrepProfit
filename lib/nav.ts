/**
 * Product modules (parity with the original PrepProfit spreadsheet kit), grouped
 * for the sidebar. `key` = i18n key under `nav`; `group.key` = key under
 * `navGroups`. Grouping mirrors DESIGN.md §6.
 */
/**
 * Standalone top-level entry, rendered above the grouped modules (no group
 * header). The Dashboard is a manager cockpit — the server redirects kitchen
 * users away from it — so the sidebar only shows this row when finance is visible.
 */
export const dashboardItem = { key: 'dashboard', href: '/dashboard' } as const;

export const navGroups = [
  {
    key: 'operations',
    items: [
      { key: 'ingredients', href: '/ingredients' },
      { key: 'recipes', href: '/recipes' },
      // Kitchen Scale (scaling workbench) — visible to BOTH roles; operational and
      // money-free by DTO type. Lives right after Recipes in Operations.
      { key: 'kitchenScale', href: '/kitchen-scale' },
      // Menus / combos (Sprint 10) — visible to BOTH roles (kitchen sees an
      // operational, money-free view); lives in Operations near Recipes.
      { key: 'menus', href: '/menus' },
      // Production planning (Sprint 11a) — visible to BOTH roles (kitchen plans a
      // money-free batch; manager also sees cost). Operations group.
      { key: 'productions', href: '/productions' },
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
      // Menu Engineering (Sprint 5, AI margin roadmap) — manager-only star/puzzle/
      // workhorse/dog matrix over cost + posted sales; finance group so kitchen hides it.
      { key: 'menuEngineering', href: '/menus/engineering' },
      // Weekly CFO Report (Sprint 8, AI margin roadmap) — manager-only weekly management
      // view over the insight modules with an optional AI write-up; finance group so kitchen
      // hides it (server enforces).
      { key: 'cfoReport', href: '/reports/cfo' },
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
export type NavItem = NavGroup['items'][number] | typeof dashboardItem;
export type NavKey = NavItem['key'];

/** Flat list — for callers that need every item (icon map, active-title lookup). */
export const navItems: readonly NavItem[] = [
  dashboardItem,
  ...navGroups.flatMap((group): readonly NavItem[] => group.items),
];
