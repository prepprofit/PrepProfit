/**
 * Dependency-free product registry of the AI features that are METERED by a per-org
 * monthly quota (AI usage meter, 2026-07). Import-light on purpose (no Drizzle, no
 * SDK, no zod) so entitlements, data helpers, and UI can all share it without pulling
 * provider/schema code into unrelated modules.
 *
 * This is the SINGLE source of truth for which features the usage meter shows, in
 * display order. Deliberately NOT derived by iterating `AI_OPERATION_FEATURES`:
 * `menu_engineering_explanation` is declared in the DB enum but has no writer and no
 * entitlement limit, so it must never surface as a meter row.
 */

/** The metered AI features, in the order the meter should display them. */
export const AI_USAGE_FEATURES = [
  'photo_recipe_extraction',
  'supplier_invoice_extraction',
  'profit_leak_explanation',
  'daily_close_summary',
  'prep_reorder_plan_summary',
  'kitchen_cfo_report',
] as const;

export type AiUsageFeature = (typeof AI_USAGE_FEATURES)[number];

/**
 * The subset of {@link AI_USAGE_FEATURES} whose usage is tracked in the GENERIC
 * `ai_operation_attempts` ledger (keyed by `feature`). `photo_recipe_extraction` is
 * excluded — it has its own dedicated `ai_extraction_attempts` ledger. Each value is
 * both an `AiUsageFeature` and an `AiOperationFeature`, so a grouped count over the
 * operation ledger maps straight back onto meter rows.
 */
export const AI_OPERATION_USAGE_FEATURES = [
  'supplier_invoice_extraction',
  'profit_leak_explanation',
  'daily_close_summary',
  'prep_reorder_plan_summary',
  'kitchen_cfo_report',
] as const;

export type AiOperationUsageFeature = (typeof AI_OPERATION_USAGE_FEATURES)[number];

/**
 * Display-order mapping from each metered feature to its i18n label key, RELATIVE to
 * the `billing.aiUsage` namespace (i.e. the panel resolves it with a
 * `getTranslations('billing.aiUsage')` translator). Keeps the label wiring in one
 * place so a renamed key can never drift from the registry.
 */
export const AI_USAGE_FEATURE_LABEL_KEY: Record<AiUsageFeature, string> = {
  photo_recipe_extraction: 'features.photo_recipe_extraction',
  supplier_invoice_extraction: 'features.supplier_invoice_extraction',
  profit_leak_explanation: 'features.profit_leak_explanation',
  daily_close_summary: 'features.daily_close_summary',
  prep_reorder_plan_summary: 'features.prep_reorder_plan_summary',
  kitchen_cfo_report: 'features.kitchen_cfo_report',
};
