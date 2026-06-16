/**
 * Predefined transaction categories — the single source of truth for the seed
 * rows written per organization and for the i18n display keys. This module is
 * pure data (no DB import) so both the server data layer and client UI can use it.
 *
 * Each predefined category is stored as a row with this `slug`; its DISPLAY name
 * comes from i18n (`finance.categories.<slug>`), so renaming is unnecessary and
 * the id stays stable for grouping. The `name` here is only the row fallback.
 * Custom per-org categories are rows with `slug = null` and a literal name.
 */

export type CategoryKind = 'income' | 'expense';

export type CategorySeed = {
  slug: string;
  kind: CategoryKind;
  /** Fallback stored in the row; the UI shows `finance.categories.<slug>`. */
  name: string;
};

/** Order here defines each predefined category's `sort_order` (array index). */
export const CATEGORY_SEED: readonly CategorySeed[] = [
  // Income
  { slug: 'food_sales', kind: 'income', name: 'Food sales' },
  { slug: 'beverage_sales', kind: 'income', name: 'Beverage sales' },
  { slug: 'catering', kind: 'income', name: 'Catering & events' },
  { slug: 'delivery', kind: 'income', name: 'Delivery / takeaway' },
  { slug: 'other_income', kind: 'income', name: 'Other income' },
  // Expense
  { slug: 'ingredients', kind: 'expense', name: 'Ingredients / Food cost' },
  { slug: 'staff_wages', kind: 'expense', name: 'Staff wages' },
  { slug: 'rent', kind: 'expense', name: 'Rent' },
  { slug: 'utilities', kind: 'expense', name: 'Utilities' },
  { slug: 'equipment', kind: 'expense', name: 'Equipment & maintenance' },
  { slug: 'packaging', kind: 'expense', name: 'Packaging & supplies' },
  { slug: 'marketing', kind: 'expense', name: 'Marketing' },
  { slug: 'fees', kind: 'expense', name: 'Fees & commissions' },
  { slug: 'other_expense', kind: 'expense', name: 'Other expense' },
] as const;

/** All predefined slugs (for the i18n key check / type guards). */
export const CATEGORY_SLUGS = CATEGORY_SEED.map((c) => c.slug);

/**
 * Display name for a category: predefined rows (slug set) resolve via i18n
 * (`finance.categories.<slug>`); custom rows (slug null) show their literal name.
 * `translate` is the next-intl translator for the `finance.categories` namespace
 * (works from both `getTranslations` on the server and `useTranslations` on the
 * client), so this stays the single rule for naming a category everywhere.
 */
export function categoryLabel(
  category: { slug: string | null; name: string },
  translate: (slug: string) => string,
): string {
  return category.slug ? translate(category.slug) : category.name;
}
