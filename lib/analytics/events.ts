/**
 * Product analytics event allowlist (Sprint 5c). A CLOSED union so we can only ever
 * send these named business events — never arbitrary, PII, or money payloads. Add a
 * new event here before capturing it. Properties are restricted to non-sensitive
 * primitives (counts, booleans, plan tier, dimensions). Never a name, email, note,
 * amount, address, or document/image content.
 */
export type AnalyticsEvent =
  | 'recipe_created'
  | 'invoice_issued'
  | 'import_committed'
  | 'recipe_photo_extracted'
  | 'organization_onboarded';

/** PII-free property bag: primitives only. */
export type AnalyticsProperties = Record<
  string,
  string | number | boolean | null
>;
