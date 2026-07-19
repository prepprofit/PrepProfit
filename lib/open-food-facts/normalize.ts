import { NUTRIENT_KEYS, type NutrientKey } from '@/lib/calculations/nutrition';
import { NUTRIENT_MAX } from '@/lib/validation/ingredient-nutrition';
import type {
  ExternalFoodSnapshot,
  ExternalFoodWarningCode,
  NutritionBasisUnit,
} from '@/lib/external-food/types';
import type { OffProduct } from './schemas';

/**
 * Open Food Facts → provider-neutral snapshot (plan §9). Untrusted input:
 * missing nutrients stay `null` (never a silent 0), values are plausibility-
 * checked against the shared ceilings, and corrupt data rejects the snapshot.
 *
 * Bump `NORMALIZATION_VERSION` whenever the mapping or derivation changes so a
 * saved snapshot records exactly which logic produced it (plan §9.2).
 */
export const NORMALIZATION_VERSION = 1;

/** kJ→kcal and salt→sodium factors (plan §9.1). */
const KJ_PER_KCAL = 4.184;
const SALT_TO_SODIUM = 2.5; // salt(g) = sodium(g) × 2.5
/** Salt/sodium agreement tolerance (g of sodium) before it is flagged. */
const SODIUM_TOLERANCE_G = 0.05;

export type NormalizeResult =
  | { ok: true; snapshot: ExternalFoodSnapshot }
  | { ok: false; reason: 'MISSING_NAME' | 'NON_FOOD' | 'BASIS_UNSUPPORTED' | 'INVALID' };

function emptyNutrients(): Record<NutrientKey, number | null> {
  const out = {} as Record<NutrientKey, number | null>;
  for (const k of NUTRIENT_KEYS) out[k] = null;
  return out;
}

/** Strip the `xx:` language prefix from a country tag: `en:france` → `france`. */
function readableCountry(tag: string): string {
  const idx = tag.indexOf(':');
  return idx >= 0 ? tag.slice(idx + 1) : tag;
}

function pickName(product: OffProduct): string | null {
  const record = product as Record<string, unknown>;
  const lang = product.lang ?? '';
  const candidates = [
    product.product_name,
    lang ? record[`product_name_${lang}`] : null,
    record['product_name_en'],
    product.generic_name,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c.trim();
  }
  return null;
}

function detectBasis(product: OffProduct): NutritionBasisUnit | null {
  const per = (product.nutrition_data_per ?? '').trim().toLowerCase();
  if (per === '100g') return 'g';
  if (per === '100ml') return 'ml';
  return null; // ambiguous/unsupported basis → rejected (plan §11)
}

/**
 * Normalize one OFF product. `requestedBarcode` is the sanitized code the user
 * looked up; the provider's `product.code` (if present) is authoritative.
 */
export function normalizeOffProduct(
  product: OffProduct,
  requestedBarcode: string,
): NormalizeResult {
  // Non-food guard (plan §11: a result that identifies a non-food product).
  if (product.product_type != null && product.product_type !== 'food') {
    return { ok: false, reason: 'NON_FOOD' };
  }

  const description = pickName(product);
  if (description === null) return { ok: false, reason: 'MISSING_NAME' };

  const basis = detectBasis(product);
  if (basis === null) return { ok: false, reason: 'BASIS_UNSUPPORTED' };

  const n = product.nutriments ?? {};
  const warnings = new Set<ExternalFoodWarningCode>();
  const derived: NutrientKey[] = [];
  const nutrients = emptyNutrients();

  // A negative/non-finite SOURCE value is corrupt → reject the whole snapshot.
  const sourceValues = [
    n['energy-kcal_100g'],
    n['energy-kj_100g'],
    n.fat_100g,
    n['saturated-fat_100g'],
    n.carbohydrates_100g,
    n.sugars_100g,
    n.fiber_100g,
    n.proteins_100g,
    n.salt_100g,
    n.sodium_100g,
  ];
  for (const v of sourceValues) {
    if (v != null && (!Number.isFinite(v) || v < 0)) {
      return { ok: false, reason: 'INVALID' };
    }
  }

  /** Assign a value to a nutrient, dropping implausible ones to null + warn. */
  const assign = (key: NutrientKey, value: number | null): void => {
    if (value == null) return;
    if (!Number.isFinite(value) || value < 0 || value > NUTRIENT_MAX[key]) {
      warnings.add('VALUE_OUT_OF_RANGE');
      return;
    }
    nutrients[key] = value;
  };

  // Energy: prefer kcal; derive from kJ when only kJ is present (plan §9.1).
  const kcal = n['energy-kcal_100g'];
  const kj = n['energy-kj_100g'];
  if (kcal != null) {
    assign('caloriesKcal', kcal);
  } else if (kj != null) {
    assign('caloriesKcal', kj / KJ_PER_KCAL);
    if (nutrients.caloriesKcal != null) {
      derived.push('caloriesKcal');
      warnings.add('ENERGY_DERIVED_FROM_KJ');
    }
  }

  assign('totalFatG', n.fat_100g ?? null);
  assign('saturatedFatG', n['saturated-fat_100g'] ?? null);
  assign('totalCarbohydrateG', n.carbohydrates_100g ?? null);
  assign('totalSugarsG', n.sugars_100g ?? null);
  assign('dietaryFiberG', n.fiber_100g ?? null);
  assign('proteinG', n.proteins_100g ?? null);

  // Salt & sodium (plan §9.1). Salt is kept for label display; sodium (mg)
  // drives the recipe calc.
  const saltG = n.salt_100g ?? null;
  const sodiumG = n.sodium_100g ?? null;
  if (sodiumG != null) {
    assign('sodiumMg', sodiumG * 1000);
    if (saltG != null) {
      const expectedSodiumG = saltG / SALT_TO_SODIUM;
      if (Math.abs(expectedSodiumG - sodiumG) > SODIUM_TOLERANCE_G) {
        warnings.add('SALT_SODIUM_MISMATCH');
      }
    }
  } else if (saltG != null) {
    assign('sodiumMg', (saltG / SALT_TO_SODIUM) * 1000);
    if (nutrients.sodiumMg != null) {
      derived.push('sodiumMg');
      warnings.add('SODIUM_DERIVED_FROM_SALT');
    }
  }

  const code = (product.code ?? requestedBarcode).trim() || requestedBarcode;
  const rev = product.rev != null ? String(product.rev) : null;
  const lastModified =
    typeof product.last_modified_t === 'number'
      ? product.last_modified_t
      : product.last_modified_t != null && Number.isFinite(Number(product.last_modified_t))
        ? Number(product.last_modified_t)
        : null;

  // Quality classification (plan §11). Core European nutrients that a
  // complete label is expected to carry.
  const CORE: NutrientKey[] = ['totalFatG', 'totalCarbohydrateG', 'proteinG'];
  if (nutrients.caloriesKcal == null) warnings.add('MISSING_ENERGY');
  const missingCore =
    CORE.some((k) => nutrients[k] == null) ||
    (nutrients.sodiumMg == null && saltG == null);
  if (missingCore) warnings.add('MISSING_CORE_NUTRIENT');
  if (basis === 'ml') warnings.add('BASIS_VOLUME');

  const isPartial =
    nutrients.caloriesKcal == null ||
    missingCore ||
    warnings.has('VALUE_OUT_OF_RANGE') ||
    warnings.has('SALT_SODIUM_MISMATCH');

  const snapshot: ExternalFoodSnapshot = {
    provider: 'open_food_facts',
    externalId: code,
    barcode: code,
    description,
    brandOwner: product.brands ? (product.brands.split(',')[0]?.trim() ?? null) : null,
    packageQuantity: product.quantity?.trim() || null,
    sourceCountry:
      product.countries_tags && product.countries_tags.length > 0
        ? product.countries_tags.map(readableCountry).join(', ')
        : null,
    sourceLanguage: product.lang?.trim() || null,
    sourceRevision: rev,
    sourceUpdatedAt: lastModified != null ? new Date(lastModified * 1000) : null,
    basis: { quantity: 100, unit: basis },
    nutrients,
    // Salt already passed the negative/non-finite source guard above; drop an
    // implausible value (> 100 g per 100 g basis) to null rather than trust it.
    saltG: saltG != null && saltG <= 100 ? saltG : null,
    derivedFields: derived,
    qualityStatus: isPartial ? 'partial' : 'complete',
    qualityWarnings: [...warnings],
    normalizationVersion: NORMALIZATION_VERSION,
  };
  return { ok: true, snapshot };
}
