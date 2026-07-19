import type { NutrientKey } from '@/lib/calculations/nutrition';

/**
 * Provider-neutral external-food domain contract (Open Food Facts integration
 * plan §5). The nutrition flow already established the correct security model
 * for USDA (server-only client, Zod-parsed untrusted payloads, `null` never a
 * silent 0, snapshot-on-save, one active profile per ingredient). This module
 * GENERALIZES that flow so a second provider (Open Food Facts) reuses the exact
 * same persistence/audit path instead of building a parallel one.
 *
 * A provider does NOT have to implement every capability. USDA does text search
 * and refresh but no barcode lookup; Open Food Facts does exact barcode lookup
 * and refresh but (in the MVP) no text search. `PROVIDER_CAPABILITIES` records
 * that, and the action layer dispatches on it — no method is forced onto a
 * provider that cannot serve it.
 */

/** External nutrition providers. `custom` is a manual profile, not a provider. */
export type NutritionProviderId = 'usda' | 'open_food_facts';

/** The `source` column of `ingredient_nutrition_profiles` (providers + manual). */
export type NutritionSourceType = NutritionProviderId | 'custom';

export type ExternalFoodQuality = 'complete' | 'partial' | 'rejected';

/**
 * Stable machine warning codes attached to a normalized snapshot. NEVER a
 * translated sentence — the UI maps each code to a localized message, and the
 * `quality_warnings` JSONB column persists the codes for audit/debug. Add a new
 * code here AND a matching `nutrition.warning.<code>` message.
 */
export type ExternalFoodWarningCode =
  /** Energy was only given in kJ; kcal derived as `kJ / 4.184`. */
  | 'ENERGY_DERIVED_FROM_KJ'
  /** Sodium was absent; derived from salt as `salt / 2.5`. */
  | 'SODIUM_DERIVED_FROM_SALT'
  /** No energy value at all — the product is at best `partial`. */
  | 'MISSING_ENERGY'
  /** One or more core European nutrients were absent (see `derivedFields`/nulls). */
  | 'MISSING_CORE_NUTRIENT'
  /** A value failed a plausibility ceiling and was dropped to `null`. */
  | 'VALUE_OUT_OF_RANGE'
  /** Reported salt and sodium disagree beyond the rounding tolerance. */
  | 'SALT_SODIUM_MISMATCH'
  /** The product is measured per 100 ml, not per 100 g (basis gate, plan §10). */
  | 'BASIS_VOLUME';

/**
 * Reference basis the nutrient values describe. The MVP only accepts the
 * 100 g / 100 ml labels documented by Open Food Facts; anything else rejects
 * the snapshot (plan §11) rather than being silently coerced.
 */
export type NutritionBasisUnit = 'g' | 'ml';

export type NutritionBasis = {
  quantity: 100;
  unit: NutritionBasisUnit;
};

/**
 * The normalized, provider-neutral result of resolving one external food. This
 * is what the action layer converts a raw provider payload into BEFORE it ever
 * touches the database — and what a save re-resolves server-side so the browser
 * never supplies nutrient values.
 */
export type ExternalFoodSnapshot = {
  provider: NutritionProviderId;
  /** FDC id (as a string) or the provider-normalized GTIN. Strings preserve leading zeroes. */
  externalId: string;
  /** Normalized product code for barcode providers; null for USDA. */
  barcode: string | null;
  description: string;
  brandOwner: string | null;
  /** Package net quantity as printed, e.g. "500 g" (display only, plan §15). */
  packageQuantity: string | null;
  /** Market/relevance country context, NOT manufacturing origin (plan §15). */
  sourceCountry: string | null;
  sourceLanguage: string | null;
  sourceRevision: string | null;
  sourceUpdatedAt: Date | null;
  basis: NutritionBasis;
  /** Per-basis nutrient values in the shared profile contract; null = unknown. */
  nutrients: Record<NutrientKey, number | null>;
  /**
   * European salt per basis (g). Kept alongside `nutrients.sodiumMg` for label
   * display even though the recipe calc is sodium-driven; null = unknown.
   */
  saltG: number | null;
  /** Which nutrients were DERIVED (kJ→kcal, salt→sodium), for provenance. */
  derivedFields: NutrientKey[];
  qualityStatus: ExternalFoodQuality;
  qualityWarnings: ExternalFoodWarningCode[];
  /** Version of PrepProfit's mapping logic; bump when derivation changes. */
  normalizationVersion: number;
};

export type ProviderCapabilities = {
  textSearch: boolean;
  barcodeLookup: boolean;
  refresh: boolean;
};

/**
 * Initial capability matrix (plan §5). USDA keeps its text search + refresh;
 * Open Food Facts adds exact barcode lookup + refresh but no text search in the
 * MVP (European name search is a separate export-backed workstream).
 */
export const PROVIDER_CAPABILITIES: Record<
  NutritionProviderId,
  ProviderCapabilities
> = {
  usda: { textSearch: true, barcodeLookup: false, refresh: true },
  open_food_facts: { textSearch: false, barcodeLookup: true, refresh: true },
};
