/** Product modules (parity with the original PrepProfit spreadsheet kit). `key` = i18n key under `nav`. */
export const navModules = [
  { key: 'dashboard', href: '/dashboard' },
  { key: 'recipes', href: '/recipes' },
  { key: 'ingredients', href: '/ingredients' },
  { key: 'inventory', href: '/inventory' },
  { key: 'breakEven', href: '/break-even' },
  { key: 'payroll', href: '/payroll' },
  { key: 'invoices', href: '/invoices' },
] as const;

export type NavModule = (typeof navModules)[number];
export type NavKey = NavModule['key'];
