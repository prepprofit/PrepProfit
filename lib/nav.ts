/** Módulos do produto (paridade com as planilhas GastroKit). `key` = chave i18n em `nav`. */
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
