import type { ProfitLeakFinding } from '@/lib/calculations/profit-leaks';

/**
 * Shared presentation helpers for profit-leak findings (Sprint 1 dashboard card +
 * Sprint 4 Profit Insight Inbox). Kept here so both surfaces render an identical
 * finding label + "open" link — no drift between the dashboard teaser and the inbox.
 *
 * The label is localized via the `dashboard.profitLeaks.finding.*` message keys; the
 * caller passes its scoped translator so we stay i18n-clean (CLAUDE.md: UI strings
 * always via next-intl) without importing next-intl here.
 */

/** A translator scoped to `dashboard.profitLeaks` (or any namespace holding `finding.*`). */
export type LeakTranslate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/** Where a finding's "open" link points — recipe/menu detail, or the ingredient list. */
export function leakHref(finding: ProfitLeakFinding): string {
  if (finding.entityType === 'recipe') return `/recipes/${finding.entityId}`;
  if (finding.entityType === 'menu') return `/menus/${finding.entityId}`;
  return '/ingredients';
}

/** The one-line, localized description of a finding. `target` fills the margin default. */
export function leakLabel(
  finding: ProfitLeakFinding,
  target: number,
  t: LeakTranslate,
): string {
  switch (finding.type) {
    case 'RECIPE_BELOW_TARGET_MARGIN':
    case 'MENU_BELOW_TARGET_MARGIN':
      return t('finding.belowMargin', {
        name: finding.entityName,
        margin: finding.currentMarginPercent ?? 0,
        target: finding.targetMarginPercent ?? target,
      });
    case 'UNPRICED_INGREDIENT_IN_ACTIVE_RECIPE':
      return t('finding.unpricedRecipe', {
        name: finding.entityName,
        count: finding.affectedEntityIds.length,
      });
    case 'UNPRICED_INGREDIENT_IN_ACTIVE_MENU':
      return t('finding.unpricedMenu', {
        name: finding.entityName,
        count: finding.affectedEntityIds.length,
      });
    case 'PENDING_PRICE_CHANGE_IMPACT':
      return t('finding.pending', {
        name: finding.entityName,
        count: finding.affectedEntityIds.length,
      });
  }
}
